import type { Server } from 'socket.io';

let io: Server | undefined;
export const setIo = (s: Server) => { io = s; };

export type Scope = 'orders' | 'tables' | 'payments' | 'products' | 'requests' | 'waiters';

/** Avisa a las pantallas del local para que recarguen. Los clientes vuelven a pedir el estado al servidor,
 *  así nunca trabajan con datos desactualizados (capítulo 28 del manual). */
export function notify(establishmentId: string, scopes: Scope[], tableToken?: string) {
  io?.to(`est:${establishmentId}`).emit('changed', { scopes });
  if (tableToken) io?.to(`table:${tableToken}`).emit('changed', { scopes });
}
