/**
 * Traducción automática de la carta (del español a seis idiomas).
 *  - Con DEEPL_API_KEY se usa DeepL (mejor calidad; la cuenta gratuita da 500.000 caracteres al mes).
 *  - Sin clave se usa MyMemory, gratuito (unos 5.000 caracteres al día; 50.000 si se indica MYMEMORY_EMAIL).
 * La traducción automática nunca pisa una traducción escrita a mano.
 */
import { sql } from '../db.js';
import { notify } from '../realtime.js';

export const LANGS = ['en', 'fr', 'de', 'it', 'pt', 'ru'] as const;
export type Lang = (typeof LANGS)[number];
const DEEPL_TARGET: Record<Lang, string> = { en: 'EN-GB', fr: 'FR', de: 'DE', it: 'IT', pt: 'PT-PT', ru: 'RU' };

let fetchImpl: typeof fetch = (...a) => fetch(...a);
let mocked = false;
export const setTranslateFetch = (f: typeof fetch) => { fetchImpl = f; mocked = true; };

/** Siempre hay traducción disponible: DeepL si hay clave, si no el servicio gratuito. */
export const translationAvailable = () => true;
export const translationProvider = () => (process.env.DEEPL_API_KEY ? 'deepl' : 'mymemory');

async function deepl(texts: string[]): Promise<Record<Lang, string[]>> {
  const key = process.env.DEEPL_API_KEY!;
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const out = {} as Record<Lang, string[]>;
  for (const lang of LANGS) {
    const res = await fetchImpl(`${host}/v2/translate`, {
      method: 'POST',
      headers: { authorization: `DeepL-Auth-Key ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: texts, source_lang: 'ES', target_lang: DEEPL_TARGET[lang], preserve_formatting: true }),
    });
    if (!res.ok) throw new Error(`DeepL respondió ${res.status}`);
    const json = (await res.json()) as { translations: { text: string }[] };
    out[lang] = json.translations.map((t) => t.text);
  }
  return out;
}

async function mymemory(texts: string[]): Promise<Record<Lang, string[]>> {
  const out = {} as Record<Lang, string[]>;
  const email = process.env.MYMEMORY_EMAIL ? `&de=${encodeURIComponent(process.env.MYMEMORY_EMAIL)}` : '';
  for (const lang of LANGS) {
    out[lang] = [];
    for (const text of texts) {
      if (!text.trim()) { out[lang].push(''); continue; }
      const res = await fetchImpl(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=es%7C${lang}${email}`);
      if (!res.ok) throw new Error(`el servicio de traducción respondió ${res.status}`);
      const j = (await res.json()) as { responseStatus: number | string; responseData?: { translatedText?: string } };
      const t = j.responseData?.translatedText ?? '';
      if (Number(j.responseStatus) !== 200 || /^MYMEMORY WARNING/i.test(t)) {
        throw new Error(Number(j.responseStatus) === 429 || /MYMEMORY WARNING/i.test(t)
          ? 'se ha alcanzado el límite diario gratuito de traducciones; inténtalo mañana o configura DeepL'
          : `el servicio de traducción respondió ${j.responseStatus}`);
      }
      out[lang].push(t);
    }
  }
  return out;
}

export function translateTexts(texts: string[]): Promise<Record<Lang, string[]>> {
  return process.env.DEEPL_API_KEY ? deepl(texts) : mymemory(texts);
}

type ProductTr = Record<string, { name?: string; description?: string; manual?: boolean }>;

/** Traduce un producto a los idiomas que no tengan traducción escrita a mano. */
export async function autoTranslateProduct(establishmentId: string, productId: string): Promise<boolean> {
  const [p] = await sql`select name, description, translations from products where id = ${productId} and establishment_id = ${establishmentId}`;
  if (!p) return false;
  const cur: ProductTr = p.translations ?? {};
  const todo = LANGS.filter((l) => !cur[l]?.manual);
  if (!todo.length) return false;
  const t = await translateTexts([p.name, p.description || '']);
  const next: ProductTr = { ...cur };
  for (const l of todo) next[l] = { name: t[l][0], description: p.description ? t[l][1] : '', manual: false };
  // Si mientras tanto alguien cambió el texto, se descarta esta traducción (ya habrá otra en marcha).
  const [u] = await sql`update products set translations = ${sql.json(next)}
                        where id = ${productId} and name = ${p.name} and description = ${p.description} returning id`;
  if (u) notify(establishmentId, ['products']);
  return !!u;
}

/** Categorías: se traducen al crearlas o renombrarlas. */
export async function autoTranslateCategory(establishmentId: string, categoryId: string): Promise<boolean> {
  const [c] = await sql`select name from categories where id = ${categoryId} and establishment_id = ${establishmentId}`;
  if (!c) return false;
  const t = await translateTexts([c.name]);
  const tr = Object.fromEntries(LANGS.map((l) => [l, t[l][0]]));
  const [u] = await sql`update categories set translations = ${sql.json(tr)} where id = ${categoryId} and name = ${c.name} returning id`;
  if (u) notify(establishmentId, ['products']);
  return !!u;
}

/** Traducción en segundo plano: guardar nunca espera a la traducción ni falla por ella. */
export function translateLater(fn: () => Promise<unknown>, log: (e: unknown) => void) {
  // En las pruebas automáticas no se sale a internet salvo que la prueba simule el servicio.
  if (process.env.NODE_ENV === 'test' && !mocked) return;
  setImmediate(() => { fn().catch(log); });
}

const running = new Set<string>();
/** Traduce en segundo plano todo lo que falte de la carta de un local (productos y categorías). */
export function translateMissing(establishmentId: string, log: (e: unknown) => void): boolean {
  if (running.has(establishmentId)) return false;
  running.add(establishmentId);
  translateLater(async () => {
    try {
      const prods = await sql`select id from products where establishment_id = ${establishmentId} and not archived
                              and (translations is null or translations = '{}'::jsonb or not (translations ?& ${[...LANGS]}))`;
      for (const p of prods) await autoTranslateProduct(establishmentId, p.id);
      const cats = await sql`select id from categories where establishment_id = ${establishmentId}
                             and (translations is null or translations = '{}'::jsonb or not (translations ?& ${[...LANGS]}))`;
      for (const c of cats) await autoTranslateCategory(establishmentId, c.id);
    } finally { running.delete(establishmentId); }
  }, (e) => { running.delete(establishmentId); log(e); });
  return true;
}

export async function missingTranslations(establishmentId: string) {
  const [r] = await sql`select
    (select count(*)::int from products where establishment_id = ${establishmentId} and not archived
       and (translations is null or translations = '{}'::jsonb or not (translations ?& ${[...LANGS]}))) as products,
    (select count(*)::int from categories where establishment_id = ${establishmentId}
       and (translations is null or translations = '{}'::jsonb or not (translations ?& ${[...LANGS]}))) as categories`;
  return { products: r.products as number, categories: r.categories as number, running: running.has(establishmentId) };
}
