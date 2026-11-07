import type { FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

/** Limitador en memoria contra fuerza bruta en los accesos. Solo cuenta intentos fallidos,
 *  porque todos los dispositivos de un local suelen salir por la misma IP. */
const MAX_FAILURES = 20;
const WINDOW_MS = 10 * 60_000;
const failures = new Map<string, { count: number; reset: number }>();
const keyOf = (req: FastifyRequest, bucket: string) => `${bucket}:${req.ip}`;

export function checkLimit(req: FastifyRequest, bucket: string) {
  const h = failures.get(keyOf(req, bucket));
  if (h && h.reset > Date.now() && h.count >= MAX_FAILURES) {
    throw new AppError(429, 'too_many_attempts', 'Demasiados intentos fallidos. Espera unos minutos.');
  }
}
export function recordFailure(req: FastifyRequest, bucket: string) {
  const k = keyOf(req, bucket);
  const now = Date.now();
  const h = failures.get(k);
  if (!h || h.reset < now) failures.set(k, { count: 1, reset: now + WINDOW_MS });
  else h.count++;
}
export const resetRateLimits = () => failures.clear();
