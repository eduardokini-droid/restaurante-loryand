import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { gunzipSync } from 'node:zlib';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { offsiteKeys, retryPendingUploads, setOffsiteFetch } from '../src/services/offsite.js';
import { signV4 } from '../src/services/s3.js';

let app: FastifyInstance;
let admin: string;
const ENV = { BACKUP_S3_ENDPOINT: 'https://abcdefgh.supabase.co/storage/v1/s3', BACKUP_S3_REGION: 'eu-west-3', BACKUP_S3_BUCKET: 'copias-restaurante', BACKUP_S3_ACCESS_KEY: 'AKTEST123', BACKUP_S3_SECRET_KEY: 'secreto-de-prueba' };
const call = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie: admin } });

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
});
afterAll(async () => { await app.close(); await sql.end(); });
afterEach(() => { for (const k of Object.keys(ENV)) delete process.env[k]; setOffsiteFetch(fetch); });

beforeEach(async () => {
  resetRateLimits();
  await sql.unsafe('truncate establishments, users cascade');
  const [e] = await sql`insert into establishments (slug, name) values ('el-laurel', 'El Laurel') returning id`;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${e.id}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin')`;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'secreto123' } });
  admin = String(r.headers['set-cookie']).split(';')[0];
});

describe('copias externas (S3 / Supabase Storage)', () => {
  it('firma S3 v4: coincide con el ejemplo oficial de AWS', () => {
    const r = signV4({
      method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('rotación: diaria por día del mes (31 días) y mensual el día 1', () => {
    expect(offsiteKeys('el-laurel', 'daily', new Date('2026-11-14T10:00:00Z'))).toEqual(['diarias/el-laurel/dia-14.json.gz']);
    expect(offsiteKeys('el-laurel', 'daily', new Date('2026-11-30T23:30:00Z'))).toEqual(['diarias/el-laurel/dia-01.json.gz', 'mensuales/el-laurel/2026-12.json.gz']);
    expect(offsiteKeys('el-laurel', 'manual', new Date('2026-11-14T10:05:00Z'))).toEqual(['manuales/el-laurel/2026-11-14_1105.json.gz']);
  });

  it('sin configurar: la copia se guarda igual y se avisa', async () => {
    const b = (await call('POST', '/api/backups')).json();
    expect(b.offsite).toEqual({ ok: false, error: 'not_configured' });
    expect((await call('GET', '/api/backups')).json().offsite.configured).toBe(false);
  });

  it('sube la copia comprimida y firmada a Supabase; si falla, queda anotado y se reintenta', async () => {
    Object.assign(process.env, ENV);
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    let fail = true;
    setOffsiteFetch((async (url: URL, init: { headers: Record<string, string>; body: Uint8Array }) => {
      sent.push({ url: String(url), headers: init.headers, body: Buffer.from(init.body) });
      return fail ? { ok: false, status: 403, text: async () => '<Error><Message>Invalid credentials</Message></Error>' } : { ok: true, text: async () => '' };
    }) as unknown as typeof fetch);
    const b = (await call('POST', '/api/backups')).json();
    expect(b.offsite).toEqual({ ok: false, error: 'El almacenamiento respondió 403: Invalid credentials' });
    let list = (await call('GET', '/api/backups')).json();
    expect(list.offsite).toMatchObject({ configured: true, bucket: 'copias-restaurante', host: 'abcdefgh.supabase.co' });
    expect(list.backups[0].offsite_error).toContain('Invalid credentials');
    fail = false;
    expect(await retryPendingUploads()).toBe(1);
    const last = sent[sent.length - 1];
    expect(last.url).toMatch(/^https:\/\/abcdefgh\.supabase\.co\/storage\/v1\/s3\/copias-restaurante\/manuales\/el-laurel\/\d{4}-\d{2}-\d{2}_\d{4}\.json\.gz$/);
    expect(last.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKTEST123\/\d{8}\/eu-west-3\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const data = JSON.parse(gunzipSync(last.body).toString());
    expect(data.format).toBe('loryand-backup');
    expect(data.establishment.name).toBe('El Laurel');
    list = (await call('GET', '/api/backups')).json();
    expect(list.backups[0].offsite_key).toMatch(/^manuales\/el-laurel\//);
    expect(list.backups[0].offsite_error).toBeNull();
    expect((await call('POST', '/api/backups/offsite-test')).json()).toEqual({ ok: true });
  });
});
