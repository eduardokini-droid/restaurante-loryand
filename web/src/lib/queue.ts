import { api, ApiError } from './api';

/**
 * Cola local de pedidos para cortes de conexión (capítulo 28).
 * Cada pedido lleva su identificador único desde que se crea: reenviarlo no lo duplica,
 * porque el servidor reconoce el identificador y devuelve el pedido ya registrado.
 */
export interface QueuedOrder { clientRequestId: string; body: any; label: string; createdAt: string; lastError?: string }
const KEY = 'loryand.orderQueue';
const listeners = new Set<() => void>();

export function readQueue(): QueuedOrder[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}
function writeQueue(q: QueuedOrder[]) {
  try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* sin almacenamiento */ }
  listeners.forEach((l) => l());
}
export const onQueueChange = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export type SendResult = { status: 'sent'; number: number; duplicate: boolean; accountId: string } | { status: 'queued' };

export async function sendOrder(body: any, label: string): Promise<SendResult> {
  try {
    const r = await api('/api/service/orders', { body });
    return { status: 'sent', number: r.number, duplicate: r.duplicate, accountId: r.accountId };
  } catch (e) {
    if (e instanceof ApiError && e.code === 'network') {
      writeQueue([...readQueue(), { clientRequestId: body.clientRequestId, body, label, createdAt: new Date().toISOString() }]);
      return { status: 'queued' };
    }
    throw e;
  }
}

let flushing = false;
export async function flushQueue(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of readQueue()) {
      try {
        await api('/api/service/orders', { body: item.body });
        writeQueue(readQueue().filter((q) => q.clientRequestId !== item.clientRequestId));
        sent++;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'network') break;
        writeQueue(readQueue().map((q) => q.clientRequestId === item.clientRequestId ? { ...q, lastError: (e as Error).message } : q));
      }
    }
  } finally { flushing = false; }
  return sent;
}
export const discardQueued = (id: string) => writeQueue(readQueue().filter((q) => q.clientRequestId !== id));
