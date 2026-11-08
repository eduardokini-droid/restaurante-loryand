import { createHash, createHmac } from 'node:crypto';

/**
 * Cliente mínimo S3 (firma AWS Signature V4) para subir archivos a un almacenamiento compatible:
 * Supabase Storage (S3), Cloudflare R2, Backblaze B2, AWS S3… Sin dependencias externas.
 */
export interface S3Config { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }

const sha256hex = (d: string | Buffer) => createHash('sha256').update(d).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
/** Codificación de URI según S3 (RFC 3986), conservando las barras de la ruta. */
const encodePath = (p: string) => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

export interface SignInput {
  method: string; url: URL; headers: Record<string, string>; payloadHash: string;
  region: string; accessKeyId: string; secretAccessKey: string; date: Date; service?: string;
}

/** Devuelve la cabecera Authorization firmada (y la firma, para pruebas). */
export function signV4(i: SignInput): { authorization: string; signature: string } {
  const service = i.service ?? 's3';
  const amzDate = i.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers = Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]));
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join('');
  const query = [...i.url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = [i.method, encodePath(decodeURIComponent(i.url.pathname)), query, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { signature, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** Sube un objeto con PUT (estilo de ruta: endpoint/bucket/clave, como exige Supabase). */
export async function putObject(cfg: S3Config, key: string, body: Buffer, contentType: string, fetchImpl: typeof fetch = fetch) {
  const url = new URL(`${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
  const date = new Date();
  const payloadHash = sha256hex(body);
  const headers: Record<string, string> = {
    host: url.host, 'x-amz-date': date.toISOString().replace(/[:-]|\.\d{3}/g, ''), 'x-amz-content-sha256': payloadHash, 'content-type': contentType,
  };
  const { authorization } = signV4({ method: 'PUT', url, headers, payloadHash, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, date });
  const res = await fetchImpl(url, { method: 'PUT', headers: { ...headers, authorization }, body: new Uint8Array(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1] ?? text.slice(0, 200);
    throw new Error(`El almacenamiento respondió ${res.status}${msg ? `: ${msg}` : ''}`);
  }
}
