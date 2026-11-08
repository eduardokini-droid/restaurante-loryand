import { z } from 'zod';
import { sql } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { accountSummary } from './accounts.js';
import { issueDocument } from './documents.js';
import { setPhysicalState } from './tables.js';

export const paymentInput = z.object({
  idempotencyKey: z.string().min(8).max(100),
  method: z.enum(['cash', 'card', 'bizum']),
  amountCents: z.number().int().positive(),
  tenderedCents: z.number().int().positive().nullish(),
});
export type PaymentInput = z.infer<typeof paymentInput>;

export interface PaymentResult {
  paymentId: string; duplicate: boolean; changeCents: number | null;
  accountStatus: string; pendingCents: number; documentId: string | null;
}

/**
 * Registra un cobro. Protecciones:
 *  - la fila de la cuenta se bloquea, así dos dispositivos no pueden cobrar a la vez;
 *  - la clave de idempotencia evita cobrar dos veces por una doble pulsación o un reintento;
 *  - nunca se cobra más de lo pendiente;
 *  - opcionalmente, no se cobra con productos sin entregar.
 */
export interface PaymentOptions {
  /** Cobro confirmado por el banco: el dinero ya está cobrado, no se bloquea por platos sin entregar ni por el QR en curso. */
  bankConfirmed?: boolean;
}

export async function registerPayment(
  establishmentId: string, accountId: string, input: PaymentInput, by: { waiterId: string | null; userId: string | null },
  opts: PaymentOptions = {},
): Promise<PaymentResult> {
  return sql.begin(async (tx) => {
    await tx`select id from establishments where id = ${establishmentId} for update`;
    const [acc] = await tx`select id, status, table_id from accounts where id = ${accountId} and establishment_id = ${establishmentId} for update`;
    if (!acc) throw notFound('Cuenta');

    const [dup] = await tx`
      select id, change_cents from payments where establishment_id = ${establishmentId} and idempotency_key = ${input.idempotencyKey}`;
    if (dup) {
      const s = await accountSummary(tx, accountId);
      const [doc] = await tx`select id from documents where account_id = ${accountId} and type = 'simplified' and status = 'valid' limit 1`;
      return { paymentId: dup.id, duplicate: true, changeCents: dup.change_cents, accountStatus: s.status, pendingCents: s.pendingCents, documentId: doc?.id ?? null };
    }

    if (acc.status !== 'open') throw conflict('account_closed', 'Esta cuenta ya está cobrada o cerrada');
    const s = await accountSummary(tx, accountId);
    if (s.totalCents === 0) throw conflict('empty_account', 'La cuenta no tiene consumiciones');

    const [est] = await tx`select settings from establishments where id = ${establishmentId}`;
    if (!opts.bankConfirmed) {
      // Un pago online en curso bloquea el cobro manual para no cobrar dos veces (capítulo 17).
      const [online] = await tx`select amount_cents from online_payments where account_id = ${accountId}
                                and status in ('pending','processing') and created_at > now() - interval '20 minutes'`;
      if (online) throw conflict('online_pending', `Hay un pago online de ${(online.amount_cents / 100).toFixed(2)} € en curso. Espera la confirmación del banco o retira el QR antes de cobrar.`);
    }
    if (!opts.bankConfirmed && est.settings?.blockPaymentUntilDelivered && s.undeliveredCount > 0) {
      throw conflict('items_pending', `Quedan ${s.undeliveredCount} producto(s) sin entregar. Márcalos como entregados antes de cobrar.`);
    }
    if (input.amountCents > s.pendingCents) {
      throw conflict('amount_exceeds', `El importe supera lo pendiente (${(s.pendingCents / 100).toFixed(2)} €)`);
    }

    let changeCents: number | null = null;
    if (input.method === 'cash' && input.tenderedCents != null) {
      if (input.tenderedCents < input.amountCents) throw badRequest('El efectivo entregado es menor que el importe');
      changeCents = input.tenderedCents - input.amountCents;
    }

    const [p] = await tx`
      insert into payments (establishment_id, account_id, method, amount_cents, tendered_cents, change_cents, idempotency_key, waiter_id, user_id, cash_session_id)
      values (${establishmentId}, ${accountId}, ${input.method}, ${input.amountCents}, ${input.tenderedCents ?? null}, ${changeCents},
              ${input.idempotencyKey}, ${by.waiterId}, ${by.userId},
              (select id from cash_sessions where establishment_id = ${establishmentId} and status = 'open'))
      returning id`;

    const pending = s.pendingCents - input.amountCents;
    let documentId: string | null = null;
    let status = 'open';
    if (pending === 0) {
      status = 'paid';
      await tx`update accounts set status = 'paid', closed_at = now() where id = ${accountId}`;
      // Pagada no es libre: la mesa queda "Pagada · aún ocupada" hasta que el personal la libere.
      if (acc.table_id) await setPhysicalState(tx, acc.table_id, 'paid_occupied');
      await tx`update service_requests set status = 'attended', attended_at = now()
               where table_id = ${acc.table_id} and kind = 'pay' and status = 'open'`;
      const doc = await issueDocument(tx, establishmentId, accountId, 'simplified');
      // Fidelización: puntos por euro pagado si la cuenta tiene un cliente identificado.
      const [a2] = await tx`select customer_id from accounts where id = ${accountId}`;
      if (a2.customer_id) {
        const perEuro = Number(est.settings?.loyalty?.pointsPerEuro ?? 1);
        await tx`update customers set points = points + ${Math.floor((s.totalCents / 100) * perEuro)} where id = ${a2.customer_id}`;
      }
      documentId = doc.id;
    }
    return { paymentId: p.id, duplicate: false, changeCents, accountStatus: status, pendingCents: pending, documentId };
  });
}
