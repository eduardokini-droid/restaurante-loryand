import type { Tx } from '../db.js';

export type PhysicalState = 'free' | 'occupied' | 'paid_occupied' | 'dirty';

/**
 * Cambia el estado físico de una mesa y registra el periodo de ocupación.
 * La ocupación empieza al sentarse y termina cuando se levantan (o al liberarla directamente):
 * ese historial alimenta la estimación de espera de la lista de espera.
 */
export async function setPhysicalState(tx: Tx, tableId: string, state: PhysicalState) {
  const [t] = await tx`select physical_state, seats from tables where id = ${tableId} for update`;
  if (!t || t.physical_state === state) return;
  await tx`update tables set physical_state = ${state} where id = ${tableId}`;
  const occupiedNow = state === 'occupied' || state === 'paid_occupied';
  const wasOccupied = t.physical_state === 'occupied' || t.physical_state === 'paid_occupied';
  if (occupiedNow && !wasOccupied) {
    await tx`insert into table_occupancy (table_id, seats, started_at) values (${tableId}, ${t.seats}, now())
             on conflict (table_id) where ended_at is null do nothing`;
  }
  if (!occupiedNow && wasOccupied) {
    await tx`update table_occupancy set ended_at = now() where table_id = ${tableId} and ended_at is null`;
  }
  if (state === 'free') {
    // Al quedar libre se renueva la clave de la carta para que el grupo anterior no pueda pedir.
    await tx`update tables set access_code = lpad((floor(random()*10000))::int::text, 4, '0') where id = ${tableId}`;
  }
}
