import { createHash, createHmac, randomBytes } from 'node:crypto';
import { sql, type Tx } from '../db.js';
import { config } from '../config.js';
import { decryptSecret } from './secrets.js';
import { normalizeRecoveryCode, verifyTotp } from './totp.js';

type Q = typeof sql | Tx;
export const sha = (t: string) => createHash('sha256').update(t).digest('hex');
export const recoveryHash = (userId: string, code: string) =>
  createHmac('sha256', config.sessionSecret).update(`${userId}:${normalizeRecoveryCode(code)}`).digest('hex');

/** Minutos de validez de los enlaces de recuperación. */
export const RESET_MINUTES = { email: 60, admin: 24 * 60 } as const;

/** Crea un enlace de recuperación de un solo uso. Anula los enlaces anteriores sin usar del mismo usuario. */
export async function createResetLink(q: Q, userId: string, origin: 'email' | 'admin', createdBy: string | null) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + RESET_MINUTES[origin] * 60_000);
  await q`delete from password_resets where user_id = ${userId} and used_at is null`;
  await q`insert into password_resets (token_hash, user_id, origin, created_by, expires_at)
          values (${sha(token)}, ${userId}, ${origin}, ${createdBy}, ${expires})`;
  return { url: `${config.publicUrl}/recuperar/${token}`, expiresAt: expires.toISOString() };
}

/**
 * Comprueba un código de 6 cifras de la aplicación de autenticación o un código de emergencia.
 * Un mismo código TOTP no vale dos veces; un código de emergencia se gasta al usarlo.
 */
export async function checkSecondFactor(tx: Tx, userId: string, code: string): Promise<'totp' | 'recovery' | null> {
  const [u] = await tx`select totp_secret_enc, totp_enabled, totp_last_step from users where id = ${userId} for update`;
  if (!u?.totp_enabled || !u.totp_secret_enc) return null;
  const step = verifyTotp(decryptSecret(u.totp_secret_enc), code);
  if (step != null) {
    if (u.totp_last_step != null && step <= Number(u.totp_last_step)) return null;
    await tx`update users set totp_last_step = ${step} where id = ${userId}`;
    return 'totp';
  }
  if (/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code.trim())) {
    const [used] = await tx`update recovery_codes set used_at = now()
                            where user_id = ${userId} and code_hash = ${recoveryHash(userId, code)} and used_at is null returning 1`;
    if (used) return 'recovery';
  }
  return null;
}
