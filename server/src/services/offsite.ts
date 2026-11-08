import { gzipSync } from 'node:zlib';
import { sql } from '../db.js';
import { putObject, type S3Config } from './s3.js';

/**
 * Copia externa de las copias de seguridad en un almacenamiento compatible con S3 (p. ej. Supabase Storage).
 * Se configura con variables de entorno del servidor (nunca desde el navegador):
 *   BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY
 *
 * Organización (sin borrar nada a mano y sin que el espacio crezca sin límite):
 *   diarias/<local>/dia-DD.json.gz      → se sobrescribe cada mes: siempre los últimos 31 días
 *   mensuales/<local>/AAAA-MM.json.gz   → la del día 1 de cada mes, se conserva
 *   manuales/<local>/AAAA-MM-DD_HHMM.json.gz y preventivas/… → las creadas a mano o antes de restaurar
 */
export function offsiteConfig(): S3Config | null {
  const e = process.env;
  if (!e.BACKUP_S3_ENDPOINT || !e.BACKUP_S3_BUCKET || !e.BACKUP_S3_ACCESS_KEY || !e.BACKUP_S3_SECRET_KEY) return null;
  return { endpoint: e.BACKUP_S3_ENDPOINT, region: e.BACKUP_S3_REGION || 'eu-west-1', bucket: e.BACKUP_S3_BUCKET, accessKeyId: e.BACKUP_S3_ACCESS_KEY, secretAccessKey: e.BACKUP_S3_SECRET_KEY };
}

let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Solo para pruebas. */
export const setOffsiteFetch = (f: typeof fetch) => { fetchImpl = f; };

const madrid = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { y: p.year, m: p.month, d: p.day, hm: `${p.hour}${p.minute}` };
};

export function offsiteKeys(slug: string, kind: string, createdAt: Date): string[] {
  const t = madrid(createdAt);
  if (kind === 'daily') {
    const keys = [`diarias/${slug}/dia-${t.d}.json.gz`];
    if (t.d === '01') keys.push(`mensuales/${slug}/${t.y}-${t.m}.json.gz`);
    return keys;
  }
  return [`${kind === 'manual' ? 'manuales' : 'preventivas'}/${slug}/${t.y}-${t.m}-${t.d}_${t.hm}.json.gz`];
}

/** Sube una copia ya guardada. Nunca lanza: deja el resultado anotado en la propia copia. */
export async function uploadBackup(backupId: string): Promise<{ ok: boolean; keys?: string[]; error?: string }> {
  const cfg = offsiteConfig();
  if (!cfg) return { ok: false, error: 'not_configured' };
  const [b] = await sql`select b.id, b.kind, b.created_at, b.data, e.slug from backups b join establishments e on e.id = b.establishment_id where b.id = ${backupId}`;
  if (!b) return { ok: false, error: 'not_found' };
  const keys = offsiteKeys(b.slug, b.kind, new Date(b.created_at));
  try {
    const body = gzipSync(Buffer.from(JSON.stringify(b.data)));
    for (const k of keys) await putObject(cfg, k, body, 'application/gzip', fetchImpl);
    await sql`update backups set offsite_key = ${keys[0]}, offsite_at = now(), offsite_error = null where id = ${b.id}`;
    return { ok: true, keys };
  } catch (e) {
    await sql`update backups set offsite_error = ${(e as Error).message} where id = ${b.id}`;
    return { ok: false, error: (e as Error).message };
  }
}

/** Reintenta las copias de los últimos 3 días que no llegaron a subirse. */
export async function retryPendingUploads(): Promise<number> {
  if (!offsiteConfig()) return 0;
  const rows = await sql`select id from backups where offsite_key is null and created_at > now() - interval '3 days' order by created_at`;
  let ok = 0;
  for (const r of rows) if ((await uploadBackup(r.id)).ok) ok++;
  return ok;
}

/** Comprobación de la conexión: sube un archivo pequeño de prueba. */
export async function testOffsite(): Promise<{ ok: boolean; error?: string }> {
  const cfg = offsiteConfig();
  if (!cfg) return { ok: false, error: 'La copia externa no está configurada en el servidor' };
  try {
    await putObject(cfg, 'prueba/conexion.txt', Buffer.from(`Restaurante Loryand · prueba de copia externa · ${new Date().toISOString()}\n`), 'text/plain; charset=utf-8', fetchImpl);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
