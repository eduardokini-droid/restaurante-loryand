import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { setTranslateFetch, translateTexts } from '../src/services/translate.js';

let app: FastifyInstance;
let admin: string;
const calls: string[] = [];
let failing = false;
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const call = (method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, payload, headers: { cookie: admin } });
const waitFor = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('tiempo agotado'); };

/** Servicio gratuito simulado: devuelve «idioma:texto». */
const fakeMyMemory = (async (url: string) => {
  calls.push(url);
  const u = new URL(url);
  if (failing) return { ok: true, json: async () => ({ responseStatus: 429, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } }) };
  const lang = u.searchParams.get('langpair')!.split('|')[1];
  return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: `${lang}:${u.searchParams.get('q')}` } }) };
}) as unknown as typeof fetch;

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
});
afterAll(async () => { await app.close(); await sql.end(); });
afterEach(() => { delete process.env.DEEPL_API_KEY; failing = false; });

beforeEach(async () => {
  resetRateLimits();
  calls.length = 0;
  setTranslateFetch(fakeMyMemory);
  await sql.unsafe('truncate establishments, users cascade');
  const [e] = await sql`insert into establishments (slug, name) values ('demo', 'Demo') returning id`;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${e.id}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin')`;
  admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'secreto123' } }));
});

const trOf = async (id: string) => (await sql`select translations from products where id = ${id}`)[0].translations;

describe('traducción automática de la carta', () => {
  it('sin clave usa el servicio gratuito; con clave de DeepL usa DeepL', async () => {
    const out = await translateTexts(['Croquetas', '']);
    expect(out.fr).toEqual(['fr:Croquetas', '']);
    expect(calls).toHaveLength(6); // el texto vacío no se envía
    process.env.DEEPL_API_KEY = 'test:fx';
    const deepl: string[] = [];
    setTranslateFetch((async (url: string, init: { body: string }) => {
      deepl.push(url);
      const b = JSON.parse(init.body);
      return { ok: true, json: async () => ({ translations: b.text.map((x: string) => ({ text: `${b.target_lang}:${x}` })) }) };
    }) as unknown as typeof fetch);
    expect((await translateTexts(['Croquetas'])).de).toEqual(['DE:Croquetas']);
    expect(deepl[0]).toBe('https://api-free.deepl.com/v2/translate');
    expect((await call('GET', '/api/admin/translation-status')).json().provider).toBe('deepl');
  });

  it('un producto nuevo se traduce solo al guardarlo y otra vez si cambia el nombre', async () => {
    const p = (await call('POST', '/api/admin/products', { name: 'Tortilla de patatas', description: 'Con cebolla', priceCents: 800, vatRate: 10 })).json();
    expect(p.id).toBeTruthy();
    await waitFor(async () => !!(await trOf(p.id))?.it);
    expect(await trOf(p.id)).toMatchObject({ en: { name: 'en:Tortilla de patatas', description: 'en:Con cebolla', manual: false }, ru: { name: 'ru:Tortilla de patatas' } });
    await call('PATCH', `/api/admin/products/${p.id}`, { name: 'Tortilla española' });
    await waitFor(async () => (await trOf(p.id)).en.name === 'en:Tortilla española');
    // Cambiar solo el precio no vuelve a traducir.
    const before = calls.length;
    await call('PATCH', `/api/admin/products/${p.id}`, { priceCents: 900 });
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.length).toBe(before);
  });

  it('una traducción escrita a mano no se pisa; el botón la rehace si se pide', async () => {
    const p = (await call('POST', '/api/admin/products', { name: 'Pulpo', priceCents: 1500, vatRate: 10,
      translations: { en: { name: 'Galician octopus', description: '', manual: true } } })).json();
    await waitFor(async () => !!(await trOf(p.id))?.fr);
    expect((await trOf(p.id)).en).toMatchObject({ name: 'Galician octopus', manual: true });
    expect((await trOf(p.id)).fr.name).toBe('fr:Pulpo');
    const u = (await call('POST', `/api/admin/products/${p.id}/translate`)).json();
    expect(u.translations.en.name).toBe('en:Pulpo');
  });

  it('las categorías se traducen solas; «traducir lo que falta» completa la carta; el límite diario avisa', async () => {
    const c = (await call('POST', '/api/admin/categories', { name: 'Postres' })).json();
    await waitFor(async () => !!(await sql`select translations from categories where id = ${c.id}`)[0].translations?.pt);
    expect((await sql`select translations from categories where id = ${c.id}`)[0].translations.pt).toBe('pt:Postres');
    // Productos antiguos sin traducir (de antes de este cambio).
    const [e] = await sql`select id from establishments`;
    await sql`insert into products (establishment_id, name, price_cents, vat_rate) values (${e.id}, 'Flan', 400, 10), (${e.id}, 'Natillas', 400, 10)`;
    expect((await call('GET', '/api/admin/translation-status')).json().missing).toMatchObject({ products: 2, categories: 0 });
    expect((await call('POST', '/api/admin/translate-missing')).json().started).toBe(true);
    await waitFor(async () => (await call('GET', '/api/admin/translation-status')).json().missing.products === 0);
    const [flan] = await sql`select translations from products where name = 'Flan'`;
    expect(flan.translations.it.name).toBe('it:Flan');
    // Límite diario del servicio gratuito: el botón devuelve un aviso claro.
    failing = true;
    const p = (await call('POST', '/api/admin/products', { name: 'Arroz', priceCents: 1200, vatRate: 10 })).json();
    const r = await call('POST', `/api/admin/products/${p.id}/translate`);
    expect(r.statusCode).toBe(502);
    expect(r.json().message).toContain('límite diario');
  });
});
