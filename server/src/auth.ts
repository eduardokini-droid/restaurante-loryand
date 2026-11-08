import { createHash, createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from './db.js';
import { config } from './config.js';
import { AppError, forbidden } from './errors.js';

export const MODULES = ['config', 'tables', 'waiters', 'users', 'tpv', 'kitchen', 'bar', 'cash', 'reservations', 'stock', 'loyalty'] as const;
export type Module = (typeof MODULES)[number];

export type Actor =
  | { kind: 'user'; id: string; name: string; role: 'superadmin' | 'admin' | 'staff'; establishmentId: string | null; permissions: string[] }
  | { kind: 'waiter'; id: string; name: string; establishmentId: string; code: number };

declare module 'fastify' {
  interface FastifyRequest { actor?: Actor }
}

export const COOKIE = 'loryand_session';
const SESSION_HOURS = 14;

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
export const pinLookup = (establishmentId: string, pin: string) =>
  createHmac('sha256', config.sessionSecret).update(`${establishmentId}:${pin}`).digest('hex');

export async function createSession(kind: 'user' | 'waiter', id: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await sql`insert into sessions (token_hash, user_id, waiter_id, expires_at)
            values (${sha(token)}, ${kind === 'user' ? id : null}, ${kind === 'waiter' ? id : null}, ${expires})`;
  return token;
}

export async function destroySession(token: string) {
  await sql`delete from sessions where token_hash = ${sha(token)}`;
}

export async function actorFromToken(token: string | undefined): Promise<Actor | undefined> {
  if (!token) return undefined;
  const [row] = await sql`
    select s.user_id, s.waiter_id,
           u.name as u_name, u.role, u.establishment_id as u_est, u.permissions, u.active as u_active,
           w.name as w_name, w.establishment_id as w_est, w.code, w.active as w_active,
           coalesce(e1.active, e2.active, true) as est_active
    from sessions s
    left join users u on u.id = s.user_id
    left join waiters w on w.id = s.waiter_id
    left join establishments e1 on e1.id = u.establishment_id
    left join establishments e2 on e2.id = w.establishment_id
    where s.token_hash = ${sha(token)} and s.expires_at > now()`;
  if (!row || !row.est_active) return undefined;
  if (row.user_id && row.u_active) {
    return { kind: 'user', id: row.user_id, name: row.u_name, role: row.role, establishmentId: row.u_est, permissions: row.permissions };
  }
  if (row.waiter_id && row.w_active) {
    return { kind: 'waiter', id: row.waiter_id, name: row.w_name, establishmentId: row.w_est, code: row.code };
  }
  return undefined;
}

export async function loadActor(req: FastifyRequest) {
  req.actor = await actorFromToken(req.cookies[COOKIE]);
}

export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) throw new AppError(401, 'unauthenticated', 'Inicia sesión para continuar');
  return req.actor;
}

/** Devuelve el establecimiento sobre el que actúa la petición. El gestor general lo indica con la cabecera x-establishment-id. */
export function establishmentOf(req: FastifyRequest): string {
  const a = requireActor(req);
  if (a.kind === 'user' && a.role === 'superadmin') {
    const h = req.headers['x-establishment-id'];
    if (typeof h !== 'string' || !h) throw new AppError(400, 'establishment_required', 'Selecciona un establecimiento');
    return h;
  }
  return a.establishmentId!;
}

export function can(a: Actor, module: Module): boolean {
  if (a.kind === 'waiter') return false;
  return a.role === 'superadmin' || a.role === 'admin' || a.permissions.includes(module);
}

export function requireModule(req: FastifyRequest, module: Module): Actor {
  const a = requireActor(req);
  if (!can(a, module)) throw forbidden();
  return a;
}

/** Acceso de servicio: camareros (PDA) o usuarios del panel con TPV. */
export function requireService(req: FastifyRequest): Actor {
  const a = requireActor(req);
  if (a.kind === 'waiter' || can(a, 'tpv')) return a;
  throw forbidden();
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: SESSION_HOURS * 3600,
  });
}

export const actorLabel = (a: Actor) => `${a.kind}:${a.id}`;
