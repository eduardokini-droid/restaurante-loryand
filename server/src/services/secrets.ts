import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Cifrado de claves de integraciones (Redsys, WhatsApp) con AES-256-GCM.
 * La clave se deriva de SESSION_SECRET: si se cambia SESSION_SECRET, hay que volver a introducir las claves.
 */
const key = () => createHash('sha256').update(`${config.sessionSecret}:integrations`).digest();

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1') throw new Error('Formato de clave desconocido');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** Muestra solo el final de una clave: "••••3456". */
export const maskSecret = (s: string) => (s.length <= 4 ? '••••' : `••••${s.slice(-4)}`);
