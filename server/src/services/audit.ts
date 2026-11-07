import type { Tx } from '../db.js';
export async function audit(tx: Tx, establishmentId: string | null, actor: string, action: string, detail: Record<string, unknown> = {}) {
  await tx`insert into audit_log (establishment_id, actor, action, detail) values (${establishmentId}, ${actor}, ${action}, ${tx.json(detail as never)})`;
}
