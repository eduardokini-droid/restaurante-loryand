import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { sql } from '../db.js';
import { actorLabel, establishmentOf, requireModule, requireService } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { audit } from '../services/audit.js';
import { accountSummary } from '../services/accounts.js';

const id = z.object({ id: z.string().uuid() });
const customerSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().max(30).default('').transform((v) => v.replace(/[\s.-]/g, '')),
  email: z.string().max(120).default(''),
  notes: z.string().max(500).default(''),
  marketingConsent: z.boolean().default(false),
});
const couponCode = () => randomBytes(4).toString('hex').toUpperCase();

/** Fidelización y cupones (capítulo 23). */
export default async function loyaltyRoutes(app: FastifyInstance) {
  app.get('/api/loyalty/customers', async (req) => {
    requireModule(req, 'loyalty');
    const est = establishmentOf(req);
    const { q } = parse(z.object({ q: z.string().max(60).default('') }), req.query);
    return sql`
      select c.*, coalesce(v.visits, 0)::int as visits, coalesce(v.spent, 0)::int as spent_cents, v.last_visit,
             (v.last_visit is null or v.last_visit < now() - interval '45 days') as inactive
      from customers c
      left join lateral (
        select count(*) as visits, max(a.closed_at) as last_visit,
               sum((select coalesce(sum(p.amount_cents), 0) from payments p where p.account_id = a.id)) as spent
        from accounts a where a.customer_id = c.id and a.status = 'paid') v on true
      where c.establishment_id = ${est}
        and (${q} = '' or c.name ilike ${'%' + q + '%'} or c.phone like ${'%' + q.replace(/\s/g, '') + '%'})
      order by c.name limit 200`;
  });

  app.post('/api/loyalty/customers', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const b = parse(customerSchema, req.body);
    if (b.phone) {
      const [dup] = await sql`select name from customers where establishment_id = ${est} and phone = ${b.phone}`;
      if (dup) throw conflict('duplicate', `Ese teléfono ya pertenece a ${dup.name}. Búscalo en lugar de crear otra ficha.`);
    }
    const [c] = await sql`insert into customers (establishment_id, name, phone, email, notes, marketing_consent)
                          values (${est}, ${b.name}, ${b.phone}, ${b.email}, ${b.notes}, ${b.marketingConsent}) returning *`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'customer.create', { id: c.id }));
    return c;
  });

  app.patch('/api/loyalty/customers/:id', async (req) => {
    requireModule(req, 'loyalty');
    const est = establishmentOf(req);
    const { id: cid } = parse(id, req.params);
    const b = parse(customerSchema.partial().extend({ points: z.number().int().min(0).optional() }), req.body);
    const cols: Record<string, unknown> = {};
    for (const [k, c] of Object.entries({ name: 'name', phone: 'phone', email: 'email', notes: 'notes', marketingConsent: 'marketing_consent', points: 'points' })) {
      if (b[k as keyof typeof b] !== undefined) cols[c] = b[k as keyof typeof b];
    }
    const [c] = await sql`update customers set ${sql(cols)} where id = ${cid} and establishment_id = ${est} returning *`;
    if (!c) throw notFound('Cliente');
    return c;
  });

  // ---------- Cupones ----------
  app.get('/api/loyalty/coupons', async (req) => {
    requireModule(req, 'loyalty');
    return sql`select k.*, c.name as customer_name from coupons k left join customers c on c.id = k.customer_id
               where k.establishment_id = ${establishmentOf(req)} order by k.created_at desc limit 300`;
  });

  app.post('/api/loyalty/coupons', async (req) => {
    const a = requireModule(req, 'loyalty');
    const est = establishmentOf(req);
    const b = parse(z.object({
      customerId: z.string().uuid().nullable().default(null),
      code: z.string().regex(/^[A-Z0-9-]{4,20}$/i, 'el código admite letras, números y guiones (4 a 20)').optional(),
      description: z.string().max(200).default(''),
      kind: z.enum(['percent', 'amount']),
      value: z.number().int().positive(),
      minTotalCents: z.number().int().min(0).default(0),
      validUntil: z.string().date().nullable().default(null),
      maxUses: z.number().int().positive().nullable().default(1),
    }), req.body);
    if (b.kind === 'percent' && b.value > 100) throw badRequest('Un porcentaje no puede superar el 100 %');
    if (b.customerId) {
      const [c] = await sql`select 1 from customers where id = ${b.customerId} and establishment_id = ${est}`;
      if (!c) throw notFound('Cliente');
    }
    const code = (b.code ?? couponCode()).toUpperCase();
    const [dup] = await sql`select 1 from coupons where establishment_id = ${est} and code = ${code}`;
    if (dup) throw conflict('duplicate', 'Ese código ya existe');
    const [k] = await sql`
      insert into coupons (establishment_id, customer_id, code, description, kind, value, min_total_cents, valid_from, valid_until, max_uses)
      values (${est}, ${b.customerId}, ${code}, ${b.description}, ${b.kind}, ${b.value}, ${b.minTotalCents}, current_date, ${b.validUntil}, ${b.maxUses})
      returning *`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'coupon.create', { id: k.id, code }));
    return k;
  });

  app.patch('/api/loyalty/coupons/:id', async (req) => {
    requireModule(req, 'loyalty');
    const { id: kid } = parse(id, req.params);
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    const [k] = await sql`update coupons set active = ${active} where id = ${kid} and establishment_id = ${establishmentOf(req)} returning *`;
    if (!k) throw notFound('Cupón');
    return k;
  });

  // ---------- En el servicio: cliente y cupón de la cuenta ----------
  app.get('/api/service/customers', async (req) => {
    requireService(req);
    const { q } = parse(z.object({ q: z.string().min(2).max(60) }), req.query);
    return sql`select id, name, phone, points from customers where establishment_id = ${establishmentOf(req)}
               and (name ilike ${'%' + q + '%'} or phone like ${'%' + q.replace(/\s/g, '') + '%'}) order by name limit 10`;
  });

  app.post('/api/service/accounts/:id/customer', async (req) => {
    requireService(req);
    const est = establishmentOf(req);
    const { id: aid } = parse(id, req.params);
    const { customerId } = parse(z.object({ customerId: z.string().uuid().nullable() }), req.body);
    if (customerId) {
      const [c] = await sql`select 1 from customers where id = ${customerId} and establishment_id = ${est}`;
      if (!c) throw notFound('Cliente');
    }
    const [acc] = await sql`update accounts set customer_id = ${customerId} where id = ${aid} and establishment_id = ${est} and status = 'open' returning id`;
    if (!acc) throw conflict('account_closed', 'Solo se puede asociar un cliente a una cuenta abierta');
    return accountSummary(sql, aid, est);
  });

  /** Aplica un cupón. Es un descuento sobre la cuenta, no un cobro. */
  app.post('/api/service/accounts/:id/coupon', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id: aid } = parse(id, req.params);
    const { code } = parse(z.object({ code: z.string().min(3).max(20) }), req.body);
    await sql.begin(async (tx) => {
      const [acc] = await tx`select id, status, customer_id from accounts where id = ${aid} and establishment_id = ${est} for update`;
      if (!acc) throw notFound('Cuenta');
      if (acc.status !== 'open') throw conflict('account_closed', 'La cuenta ya está cerrada');
      const [k] = await tx`select * from coupons where establishment_id = ${est} and code = ${code.trim().toUpperCase()} for update`;
      if (!k || !k.active) throw conflict('coupon_invalid', 'Cupón no válido o desactivado');
      const [{ today }] = await tx`select (now() at time zone 'Europe/Madrid')::date as today`;
      if (k.valid_from && k.valid_from > today) throw conflict('coupon_not_yet', 'Este cupón todavía no es válido');
      if (k.valid_until && k.valid_until < today) throw conflict('coupon_expired', 'Este cupón ha caducado');
      if (k.max_uses != null && k.uses >= k.max_uses) throw conflict('coupon_used', 'Este cupón ya se ha utilizado');
      if (k.customer_id) {
        if (acc.customer_id && acc.customer_id !== k.customer_id) throw conflict('coupon_other_customer', 'Este cupón pertenece a otro cliente');
        if (!acc.customer_id) await tx`update accounts set customer_id = ${k.customer_id} where id = ${aid}`;
      }
      const [already] = await tx`select 1 from account_discounts where account_id = ${aid} and coupon_id = ${k.id}`;
      if (already) throw conflict('coupon_applied', 'Este cupón ya está aplicado en la cuenta');
      const s = await accountSummary(tx, aid, est);
      if (s.itemsTotalCents < k.min_total_cents) throw conflict('coupon_min', `El cupón exige un consumo mínimo de ${(k.min_total_cents / 100).toFixed(2)} €`);
      const amount = Math.min(k.kind === 'percent' ? Math.floor((s.itemsTotalCents * k.value) / 100) : k.value, s.pendingCents);
      if (amount <= 0) throw conflict('coupon_nothing', 'No queda importe pendiente al que aplicar el cupón');
      if (amount >= s.pendingCents && s.paidCents === 0) throw conflict('coupon_full', 'Un cupón no puede dejar la cuenta a cero. Registra la invitación anulando los productos.');
      const label = k.kind === 'percent' ? `Cupón ${k.code} (-${k.value} %)` : `Cupón ${k.code}`;
      await tx`insert into account_discounts (account_id, coupon_id, label, amount_cents) values (${aid}, ${k.id}, ${label}, ${amount})`;
      await tx`update coupons set uses = uses + 1 where id = ${k.id}`;
      await audit(tx, est, actorLabel(a), 'coupon.apply', { accountId: aid, couponId: k.id, amount });
    });
    notify(est, ['orders', 'tables']);
    return accountSummary(sql, aid, est);
  });

  app.delete('/api/service/accounts/:id/discounts/:discountId', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id: aid, discountId } = parse(z.object({ id: z.string().uuid(), discountId: z.string().uuid() }), req.params);
    await sql.begin(async (tx) => {
      const [acc] = await tx`select status from accounts where id = ${aid} and establishment_id = ${est} for update`;
      if (!acc || acc.status !== 'open') throw conflict('account_closed', 'La cuenta ya está cerrada');
      const [d] = await tx`delete from account_discounts where id = ${discountId} and account_id = ${aid} returning coupon_id`;
      if (!d) throw notFound('Descuento');
      if (d.coupon_id) await tx`update coupons set uses = greatest(uses - 1, 0) where id = ${d.coupon_id}`;
      await audit(tx, est, actorLabel(a), 'coupon.remove', { accountId: aid, discountId });
    });
    notify(est, ['orders', 'tables']);
    return accountSummary(sql, aid, est);
  });

  // ---------- Tarjeta digital pública ----------
  app.get('/api/public/card/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[a-f0-9]{24}$/) }), req.params);
    const [c] = await sql`select c.id, c.name, c.points, e.name as establishment from customers c join establishments e on e.id = c.establishment_id
                          where c.card_token = ${token} and e.active`;
    if (!c) throw notFound('Tarjeta');
    const coupons = await sql`select code, description, kind, value, valid_until from coupons
                              where customer_id = ${c.id} and active and (max_uses is null or uses < max_uses)
                                and (valid_until is null or valid_until >= current_date) order by created_at desc`;
    return { establishment: c.establishment, name: c.name.split(' ')[0], points: c.points, coupons };
  });
}
