import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { checkLimit, recordFailure } from '../ratelimit.js';
import { createOrder, orderInput } from '../services/orders.js';
import { accountSummary } from '../services/accounts.js';

const token = z.object({ token: z.string().min(10).max(64) });

interface PublicTable {
  id: string; label: string; access_code: string; access_open: boolean; establishment_id: string;
  qr_token: string; establishment_name: string; active: boolean;
}

async function tableByToken(t: string): Promise<PublicTable> {
  const [row] = await sql<PublicTable[]>`
    select t.id, t.label, t.access_code, t.access_open, t.establishment_id, t.qr_token, e.name as establishment_name, e.active
    from tables t join establishments e on e.id = t.establishment_id
    where t.qr_token = ${t} and t.active`;
  if (!row || !row.active) throw notFound('Mesa');
  return row;
}

/** Comprueba la clave temporal de la mesa. Con límite de intentos fallidos: son solo 4 cifras. */
function checkCode(req: FastifyRequest, table: { access_open: boolean; access_code: string; qr_token: string }, code: string | undefined) {
  const bucket = `table:${table.qr_token}`;
  checkLimit(req, bucket);
  if (!table.access_open) throw new AppError(403, 'access_closed', 'El acceso de esta mesa está cerrado. Pide ayuda al camarero.');
  if (code !== table.access_code) {
    recordFailure(req, bucket);
    throw new AppError(403, 'bad_code', 'La clave de la mesa no es correcta. Pídela al camarero.');
  }
}

export default async function publicRoutes(app: FastifyInstance) {
  app.get('/api/public/table/:token', async (req) => {
    const { token: tk } = parse(token, req.params);
    const t = await tableByToken(tk);
    const categories = await sql`select id, parent_id, name, sort from categories where establishment_id = ${t.establishment_id} order by sort, name`;
    const products = await sql`
      select id, name, description, price_cents, options, allergens, category_id, subcategory_id, photo_url, translations
      from products where establishment_id = ${t.establishment_id} and visible and not archived order by name`;
    return { establishment: t.establishment_name, table: { label: t.label, accessOpen: t.access_open }, categories, products };
  });

  app.post('/api/public/table/:token/verify', async (req) => {
    const { token: tk } = parse(token, req.params);
    const { accessCode } = parse(z.object({ accessCode: z.string().max(10) }), req.body);
    checkCode(req, await tableByToken(tk), accessCode);
    return { ok: true };
  });

  app.post('/api/public/table/:token/orders', async (req) => {
    const { token: tk } = parse(token, req.params);
    const t = await tableByToken(tk);
    const body = parse(z.object({ accessCode: z.string().max(10), clientRequestId: orderInput.shape.clientRequestId, items: orderInput.shape.items, note: orderInput.shape.note }), req.body);
    checkCode(req, t, body.accessCode);
    const r = await createOrder(
      { clientRequestId: body.clientRequestId, items: body.items, note: body.note, target: { tableId: t.id } },
      { establishmentId: t.establishment_id, source: 'client', waiterId: null, userId: null },
    );
    if (!r.duplicate) notify(t.establishment_id, ['orders', 'tables'], t.qr_token);
    return { number: r.number, duplicate: r.duplicate };
  });

  app.post('/api/public/table/:token/account', async (req) => {
    const { token: tk } = parse(token, req.params);
    const t = await tableByToken(tk);
    const { accessCode } = parse(z.object({ accessCode: z.string().max(10) }), req.body);
    checkCode(req, t, accessCode);
    const [acc] = await sql`select id from accounts where table_id = ${t.id} and status = 'open'`;
    if (!acc) return { items: [], totalCents: 0, pendingCents: 0 };
    const s = await accountSummary(sql, acc.id);
    return {
      items: s.items.filter((i) => i.status !== 'cancelled').map((i) => ({ name: i.name, option: i.option, qty: i.qty, unitCents: i.unitCents, status: i.status, orderNumber: i.orderNumber })),
      totalCents: s.totalCents, pendingCents: s.pendingCents,
    };
  });

  app.post('/api/public/table/:token/requests', async (req) => {
    const { token: tk } = parse(token, req.params);
    const t = await tableByToken(tk);
    const b = parse(z.object({ accessCode: z.string().max(10), kind: z.enum(['pay', 'waiter', 'other']), note: z.string().max(200).default('') }), req.body);
    checkCode(req, t, b.accessCode);
    await sql`insert into service_requests (establishment_id, table_id, kind, note) values (${t.establishment_id}, ${t.id}, ${b.kind}, ${b.note})
              on conflict (table_id, kind) where status = 'open' do nothing`;
    notify(t.establishment_id, ['requests', 'tables']);
    return { ok: true };
  });
}
