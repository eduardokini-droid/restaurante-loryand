import { sql, type Tx } from '../db.js';
import { config } from '../config.js';
import { conflict, notFound } from '../errors.js';
import { accountSummary } from './accounts.js';
import { registerPayment } from './payments.js';
import { buildPaymentForm, isAuthorized, newOrderCode, parseNotification } from './redsys.js';
import { decryptSecret } from './secrets.js';

type Q = typeof sql | Tx;

export interface RedsysConfig { merchantCode: string; terminal: string; environment: 'test' | 'live'; card: boolean; bizum: boolean }

export async function getRedsys(q: Q, establishmentId: string): Promise<{ enabled: boolean; config: RedsysConfig; secret: string | null } | null> {
  const [r] = await q`select enabled, config, secret_enc from integrations where establishment_id = ${establishmentId} and kind = 'redsys'`;
  if (!r) return null;
  return { enabled: r.enabled, config: r.config, secret: r.secret_enc ? decryptSecret(r.secret_enc) : null };
}

/** Genera (o reutiliza) el cobro online de la cuenta por el importe pendiente en este momento. */
export async function createOnlinePayment(establishmentId: string, accountId: string, createdBy: string) {
  return sql.begin(async (tx) => {
    const r = await getRedsys(tx, establishmentId);
    if (!r?.enabled || !r.secret) throw conflict('online_disabled', 'El cobro online no está habilitado en este establecimiento');
    const [acc] = await tx`select status from accounts where id = ${accountId} and establishment_id = ${establishmentId} for update`;
    if (!acc) throw notFound('Cuenta');
    if (acc.status !== 'open') throw conflict('account_closed', 'La cuenta ya está cobrada o cerrada');
    const s = await accountSummary(tx, accountId);
    if (s.pendingCents <= 0) throw conflict('nothing_pending', 'La cuenta no tiene importe pendiente');
    const [existing] = await tx`select * from online_payments where account_id = ${accountId} and status = 'pending'
                                and created_at > now() - interval '20 minutes' order by created_at desc limit 1`;
    if (existing && existing.amount_cents === s.pendingCents) return existing;
    // Si el importe ha cambiado, el QR anterior se retira: lo añadido después se cobra aparte.
    await tx`update online_payments set status = 'cancelled', updated_at = now() where account_id = ${accountId} and status = 'pending'`;
    const [p] = await tx`
      insert into online_payments (establishment_id, account_id, order_code, amount_cents, environment, created_by)
      values (${establishmentId}, ${accountId}, ${newOrderCode()}, ${s.pendingCents}, ${r.config.environment}, ${createdBy})
      returning *`;
    return p;
  });
}

export async function startOnlinePayment(token: string, method: 'card' | 'bizum') {
  const [p] = await sql`
    select op.*, e.name as establishment_name, coalesce('Mesa ' || t.label, 'Barra · ' || a.bar_name) as place
    from online_payments op join establishments e on e.id = op.establishment_id
    join accounts a on a.id = op.account_id left join tables t on t.id = a.table_id
    where op.token = ${token}`;
  if (!p) throw notFound('Pago');
  if (p.status !== 'pending') throw conflict('not_pending', p.status === 'paid' ? 'Este pago ya está completado' : 'Este código de pago ya no es válido. Pide uno nuevo al personal.');
  const r = await getRedsys(sql, p.establishment_id);
  if (!r?.enabled || !r.secret) throw conflict('online_disabled', 'El cobro online no está habilitado');
  if ((method === 'bizum' && !r.config.bizum) || (method === 'card' && !r.config.card)) throw conflict('method_disabled', 'Ese método de pago no está disponible');
  await sql`update online_payments set method = ${method}, updated_at = now() where id = ${p.id}`;
  const back = `${config.publicUrl}/pagar/${token}`;
  return buildPaymentForm({
    merchantCode: r.config.merchantCode, terminal: r.config.terminal, secret: r.secret, environment: p.environment,
    order: p.order_code, amountCents: p.amount_cents, method,
    description: `${p.establishment_name} · ${p.place}`, merchantName: p.establishment_name,
    notifyUrl: `${config.publicUrl}/api/redsys/notify`, okUrl: `${back}?resultado=ok`, koUrl: `${back}?resultado=ko`,
  });
}

/**
 * Notificación del banco. Solo esta llamada confirma un pago: abrir o cerrar la página de pago no prueba nada.
 * Si el banco autoriza pero la cuenta ya no admite el cobro (p. ej. se cobró en efectivo mientras tanto),
 * el pago queda en "conflict" para revisarlo y devolverlo desde Redsys: nunca se pierde un cobro bancario.
 */
export async function handleNotification(form: Record<string, string>): Promise<{ ok: boolean; status?: string; establishmentId?: string; accountId?: string }> {
  const params = form.Ds_MerchantParameters;
  const signature = form.Ds_Signature;
  if (!params || !signature) return { ok: false };
  let order: string | undefined;
  try { const raw = JSON.parse(Buffer.from(params.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); order = raw.Ds_Order ?? raw.DS_ORDER; } catch { return { ok: false }; }
  if (!order) return { ok: false };
  const [p] = await sql`select * from online_payments where order_code = ${order}`;
  if (!p) return { ok: false };
  const r = await getRedsys(sql, p.establishment_id);
  if (!r?.secret) return { ok: false };
  const n = parseNotification(r.secret, params, signature);
  if (!n) return { ok: false }; // firma no válida: se ignora
  if (p.status === 'paid') return { ok: true, status: 'paid', establishmentId: p.establishment_id, accountId: p.account_id };

  if (!isAuthorized(n.response)) {
    await sql`update online_payments set status = 'failed', response_code = ${String(n.response)}, updated_at = now() where id = ${p.id} and status <> 'paid'`;
    return { ok: true, status: 'failed', establishmentId: p.establishment_id, accountId: p.account_id };
  }
  if (n.amountCents !== p.amount_cents) {
    await sql`update online_payments set status = 'conflict', response_code = ${String(n.response)}, auth_code = ${n.authCode},
              error = ${`Importe del banco (${n.amountCents}) distinto del previsto (${p.amount_cents})`}, updated_at = now() where id = ${p.id}`;
    return { ok: true, status: 'conflict', establishmentId: p.establishment_id, accountId: p.account_id };
  }
  try {
    const res = await registerPayment(p.establishment_id, p.account_id,
      { idempotencyKey: `redsys:${p.order_code}`, method: p.method === 'bizum' ? 'bizum' : 'card', amountCents: p.amount_cents, tenderedCents: null },
      { waiterId: null, userId: null }, { bankConfirmed: true });
    await sql`update online_payments set status = 'paid', response_code = ${String(n.response)}, auth_code = ${n.authCode}, payment_id = ${res.paymentId}, updated_at = now() where id = ${p.id}`;
    return { ok: true, status: 'paid', establishmentId: p.establishment_id, accountId: p.account_id };
  } catch (e) {
    await sql`update online_payments set status = 'conflict', response_code = ${String(n.response)}, auth_code = ${n.authCode},
              error = ${(e as Error).message}, updated_at = now() where id = ${p.id}`;
    return { ok: true, status: 'conflict', establishmentId: p.establishment_id, accountId: p.account_id };
  }
}
