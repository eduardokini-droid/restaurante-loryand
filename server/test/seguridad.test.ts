import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { config } from '../src/config.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { bootstrap } from '../src/bootstrap.js';
import { setMailFetch } from '../src/services/mail.js';
import { base32Decode, currentStep, hotp, verifyTotp } from '../src/services/totp.js';

let app: FastifyInstance;
let est: string;
let staffId: string;
const mails: { to: string[]; text: string }[] = [];
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const call = (cookie: string, method: string, url: string, payload?: object, extra: Record<string, string> = {}) =>
  app.inject({ method: method as 'POST', url, payload, headers: { cookie, ...extra } });
const login = (username: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
const codeAt = (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), currentStep() + offsetSteps);

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
  setMailFetch((async (_u: string, init: { body: string }) => { mails.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }) as unknown as typeof fetch);
});
afterAll(async () => { setMailFetch(fetch); await app.close(); await sql.end(); });

beforeEach(async () => {
  resetRateLimits();
  mails.length = 0;
  config.requireGestorMfa = false;
  delete process.env.MAIL_RESEND_API_KEY; delete process.env.MAIL_FROM;
  await sql.unsafe('truncate establishments, users cascade');
  const [e] = await sql`insert into establishments (slug, name) values ('demo', 'Casa Demo') returning id`;
  est = e.id;
  await sql`insert into users (username, name, password_hash, role) values ('gestor', 'Gestor', ${await hashPassword('gestor-secreto-1')}, 'superadmin')`;
  await sql`insert into users (establishment_id, username, name, password_hash, role, email) values (${est}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin', 'admin@casa.es')`;
  const [s] = await sql`insert into users (establishment_id, username, name, password_hash, role, permissions) values (${est}, 'caja', 'Caja', ${await hashPassword('caja12345')}, 'staff', '{cash}') returning id`;
  staffId = s.id;
});

describe('TOTP', () => {
  it('cumple el vector de la RFC 6238 y admite un paso de desfase', () => {
    const key = Buffer.from('12345678901234567890');
    expect(hotp(key, 1, 8)).toBe('94287082');               // T = 59 s
    expect(hotp(key, 37037036, 8)).toBe('07081804');        // T = 1111111109 s
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';        // base32 de "12345678901234567890"
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    const now = 59_000;
    expect(verifyTotp(secret, hotp(key, 1), now)).toBe(1);
    expect(verifyTotp(secret, hotp(key, 0), now)).toBe(0);
    expect(verifyTotp(secret, hotp(key, 3), now)).toBeNull();
  });
});

describe('recuperar la contraseña', () => {
  it('por correo: respuesta genérica, enlace de un solo uso y cierre de sesiones', async () => {
    process.env.MAIL_RESEND_API_KEY = 're_prueba'; process.env.MAIL_FROM = 'Loryand <no-responder@loryand.es>';
    const old = cookieOf(await login('admin', 'secreto123'));
    // Usuario que no existe: misma respuesta y ningún correo.
    expect((await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { login: 'nadie' } })).json()).toEqual({ ok: true, mail: true });
    expect(mails).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { login: 'ADMIN@casa.es' } })).json()).toEqual({ ok: true, mail: true });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(['admin@casa.es']);
    const token = mails[0].text.match(/\/recuperar\/([\w-]+)/)![1];
    expect((await app.inject({ method: 'GET', url: `/api/auth/reset/${token}` })).json()).toMatchObject({ username: 'admin', totpEnabled: false });
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'corta' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'nueva-clave-1' } })).json()).toEqual({ ok: true });
    // Un solo uso, sesión anterior cerrada, contraseña antigua inválida, la nueva vale.
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'otra-clave-2' } })).statusCode).toBe(410);
    expect((await call(old, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await login('admin', 'secreto123')).statusCode).toBe(401);
    expect((await login('admin', 'nueva-clave-1')).json()).toEqual({ ok: true });
    const [a] = await sql`select action, detail from audit_log where action = 'auth.password_reset'`;
    expect(a.detail).toMatchObject({ origin: 'email' });
  });

  it('sin correo configurado no se envía nada; el administrador genera el enlace de su personal, no el suyo', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { login: 'admin' } })).json()).toEqual({ ok: true, mail: false });
    const admin = cookieOf(await login('admin', 'secreto123'));
    const link = (await call(admin, 'POST', `/api/admin/users/${staffId}/reset-link`)).json();
    expect(link.url).toMatch(/\/recuperar\/[\w-]{40,}$/);
    const [me] = await sql`select id from users where username = 'admin'`;
    expect((await call(admin, 'POST', `/api/admin/users/${me.id}/reset-link`)).statusCode).toBe(403);
    // El gestor sí puede generarlo para el administrador.
    const gestor = cookieOf(await login('gestor', 'gestor-secreto-1'));
    expect((await call(gestor, 'POST', `/api/admin/users/${me.id}/reset-link`, undefined, { 'x-establishment-id': est })).statusCode).toBe(200);
    // Un enlace nuevo anula el anterior.
    const second = (await call(admin, 'POST', `/api/admin/users/${staffId}/reset-link`)).json();
    const t1 = link.url.split('/').pop(); const t2 = second.url.split('/').pop();
    expect((await app.inject({ method: 'GET', url: `/api/auth/reset/${t1}` })).statusCode).toBe(410);
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: t2, password: 'caja-nueva-1' } })).statusCode).toBe(200);
    expect((await login('caja', 'caja-nueva-1')).json()).toEqual({ ok: true });
  });

  it('cambiar la propia contraseña mantiene esta sesión y cierra las demás', async () => {
    const a = cookieOf(await login('caja', 'caja12345'));
    const b = cookieOf(await login('caja', 'caja12345'));
    expect((await call(a, 'POST', '/api/auth/password', { currentPassword: 'mala', password: 'caja-nueva-1' })).statusCode).toBe(401);
    expect((await call(a, 'POST', '/api/auth/password', { currentPassword: 'caja12345', password: 'caja-nueva-1' })).statusCode).toBe(200);
    expect((await call(a, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await call(b, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });
});

describe('doble verificación', () => {
  async function enable(cookie: string, pw: string) {
    const s = (await call(cookie, 'POST', '/api/auth/2fa/setup', { currentPassword: pw })).json();
    expect(s.otpauth).toContain(`secret=${s.secret}`);
    expect((await call(cookie, 'POST', '/api/auth/2fa/enable', { code: '000000' })).statusCode).toBe(400);
    const r = (await call(cookie, 'POST', '/api/auth/2fa/enable', { code: codeAt(s.secret) })).json();
    expect(r.recoveryCodes).toHaveLength(10);
    return { secret: s.secret as string, codes: r.recoveryCodes as string[] };
  }

  it('el acceso pide el código; no se reutiliza; los códigos de emergencia son de un solo uso', async () => {
    const c = cookieOf(await login('admin', 'secreto123'));
    const { secret, codes } = await enable(c, 'secreto123');
    const step1 = (await login('admin', 'secreto123')).json();
    expect(step1).toMatchObject({ ok: false, needs2fa: true });
    expect((await login('admin', 'secreto123')).headers['set-cookie']).toBeUndefined();
    // El código usado para activar no vale otra vez; el del paso siguiente sí.
    expect((await app.inject({ method: 'POST', url: '/api/auth/login/2fa', payload: { challenge: step1.challenge, code: codeAt(secret) } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login/2fa', payload: { challenge: step1.challenge, code: codeAt(secret, 1) } });
    expect(ok.json()).toMatchObject({ ok: true, usedRecoveryCode: false });
    expect((await call(cookieOf(ok), 'GET', '/api/auth/me')).json().actor.mfa).toBe(true);
    // El reto ya no sirve.
    expect((await app.inject({ method: 'POST', url: '/api/auth/login/2fa', payload: { challenge: step1.challenge, code: codes[0] } })).statusCode).toBe(410);
    // Código de emergencia (en minúsculas y sin guion también vale), solo una vez.
    const s2 = (await login('admin', 'secreto123')).json();
    const r = await app.inject({ method: 'POST', url: '/api/auth/login/2fa', payload: { challenge: s2.challenge, code: codes[0].toLowerCase().replace('-', '') } });
    expect(r.json()).toMatchObject({ ok: true, usedRecoveryCode: true });
    const s3 = (await login('admin', 'secreto123')).json();
    expect((await app.inject({ method: 'POST', url: '/api/auth/login/2fa', payload: { challenge: s3.challenge, code: codes[0] } })).statusCode).toBe(401);
    expect((await call(c, 'GET', '/api/auth/account')).json()).toMatchObject({ totpEnabled: true, recoveryCodesLeft: 9 });
  });

  it('cinco códigos erróneos anulan el reto; recuperar la contraseña no quita la doble verificación', async () => {
    process.env.MAIL_RESEND_API_KEY = 're_prueba'; process.env.MAIL_FROM = 'x@y.es';
    const c = cookieOf(await login('admin', 'secreto123'));
    const { secret } = await enable(c, 'secreto123');
    const s = (await login('admin', 'secreto123')).json();
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'POST', url: '/api/auth/login/2fa', payload: { challenge: s.challenge, code: '123456' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login/2fa', payload: { challenge: s.challenge, code: codeAt(secret, 1) } })).statusCode).toBe(410);
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { login: 'admin' } });
    const token = mails[0].text.match(/\/recuperar\/([\w-]+)/)![1];
    expect((await app.inject({ method: 'GET', url: `/api/auth/reset/${token}` })).json().totpEnabled).toBe(true);
    await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'nueva-clave-1' } });
    expect((await login('admin', 'nueva-clave-1')).json()).toMatchObject({ needs2fa: true });
  });

  it('el gestor está obligado a activarla; el administrador se la quita a su personal', async () => {
    config.requireGestorMfa = true;
    const g = cookieOf(await login('gestor', 'gestor-secreto-1'));
    expect((await call(g, 'GET', '/api/auth/me')).json().mfaRequired).toBe(true);
    const blocked = await call(g, 'GET', '/api/platform/establishments');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('mfa_required');
    const { secret } = await enable(g, 'gestor-secreto-1');
    expect((await call(g, 'GET', '/api/platform/establishments')).statusCode).toBe(200);
    expect((await call(g, 'POST', '/api/auth/2fa/disable', { currentPassword: 'gestor-secreto-1', code: codeAt(secret, 1) })).statusCode).toBe(403);

    const staff = cookieOf(await login('caja', 'caja12345'));
    await enable(staff, 'caja12345');
    const admin = cookieOf(await login('admin', 'secreto123'));
    expect((await call(admin, 'POST', `/api/admin/users/${staffId}/reset-2fa`)).statusCode).toBe(200);
    expect((await call(staff, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await login('caja', 'caja12345')).json()).toEqual({ ok: true });
  });
});

describe('último recurso del gestor', () => {
  it('GESTOR_RECOVERY con la fecha de hoy restablece la clave y quita la doble verificación una sola vez', async () => {
    const g = cookieOf(await login('gestor', 'gestor-secreto-1'));
    const s = (await call(g, 'POST', '/api/auth/2fa/setup', { currentPassword: 'gestor-secreto-1' })).json();
    await call(g, 'POST', '/api/auth/2fa/enable', { code: codeAt(s.secret) });
    const logs: string[] = [];
    Object.assign(process.env, { BOOTSTRAP_ADMIN_USER: 'gestor', BOOTSTRAP_ADMIN_PASSWORD: 'clave-de-render-12', GESTOR_RECOVERY: '2001-01-01' });
    try {
      await bootstrap((m) => logs.push(m));
      expect((await login('gestor', 'clave-de-render-12')).statusCode).toBe(401); // fecha que no es hoy: nada
      process.env.GESTOR_RECOVERY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
      await bootstrap((m) => logs.push(m));
      expect((await login('gestor', 'clave-de-render-12')).json()).toEqual({ ok: true });
      expect((await call(g, 'GET', '/api/auth/me')).statusCode).toBe(401);
      // Segunda vez el mismo día (otro reinicio): no vuelve a tocar nada.
      await sql`update users set password_hash = ${await hashPassword('otra-clave-123')} where username = 'gestor'`;
      await bootstrap((m) => logs.push(m));
      expect((await login('gestor', 'otra-clave-123')).json()).toEqual({ ok: true });
      expect(logs.some((l) => l.includes('ya se aplicó hoy'))).toBe(true);
    } finally {
      for (const k of ['BOOTSTRAP_ADMIN_USER', 'BOOTSTRAP_ADMIN_PASSWORD', 'GESTOR_RECOVERY']) delete process.env[k];
    }
  });
});
