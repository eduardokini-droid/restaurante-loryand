import { z } from 'zod';
import { sql, type Tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { openBarAccount, openTableAccount } from './accounts.js';

export const orderInput = z.object({
  clientRequestId: z.string().min(8).max(100),
  target: z.union([
    z.object({ accountId: z.string().uuid() }),
    z.object({ tableId: z.string().uuid() }),
    z.object({ barName: z.string().min(1).max(60) }),
  ]),
  items: z.array(z.object({
    productId: z.string().uuid(),
    qty: z.number().int().min(1).max(99),
    option: z.string().max(90).nullish(),
    course: z.number().int().min(1).max(5).nullish(),
  })).min(1).max(100),
  note: z.string().max(300).default(''),
});
export type OrderInput = z.infer<typeof orderInput>;

export interface OrderContext {
  establishmentId: string;
  source: 'tpv' | 'pda' | 'client';
  waiterId: string | null;
  userId: string | null;
}

export interface OrderResult { orderId: string; number: number; accountId: string; duplicate: boolean }

export async function createOrder(input: OrderInput, ctx: OrderContext): Promise<OrderResult> {
  return sql.begin(async (tx) => {
    // Serializa la numeración de pedidos del local y el control de duplicados.
    await tx`select id from establishments where id = ${ctx.establishmentId} for update`;

    const [dup] = await tx`
      select id, number, account_id from orders
      where establishment_id = ${ctx.establishmentId} and client_request_id = ${input.clientRequestId}`;
    if (dup) return { orderId: dup.id, number: dup.number, accountId: dup.account_id, duplicate: true };

    const accountId = await resolveAccount(tx, input.target, ctx);

    const ids = [...new Set(input.items.map((i) => i.productId))];
    const products = await tx`
      select id, name, price_cents, vat_rate, destination, course, options, visible
      from products
      where establishment_id = ${ctx.establishmentId} and id in ${tx(ids)} and not archived`;
    const byId = new Map(products.map((p) => [p.id, p]));

    const lines = input.items.map((item) => {
      const p = byId.get(item.productId);
      if (!p) throw badRequest('Uno de los productos ya no está disponible');
      if (ctx.source === 'client' && !p.visible) throw badRequest(`«${p.name}» no está disponible en la carta`);
      const options: string[] = p.options;
      let option: string | null = item.option?.trim() || null;
      if (options.length > 0) {
        if (!option) throw badRequest(`Elige una opción para «${p.name}»`);
        if (!options.includes(option)) throw badRequest(`La opción «${option}» no existe para «${p.name}»`);
      } else {
        option = null;
      }
      // El precio sale siempre de la base de datos, nunca del dispositivo.
      return { p, qty: item.qty, option, course: item.course ?? p.course };
    });

    const minCourse = Math.min(...lines.map((l) => l.course));
    const [{ next }] = await tx`
      select coalesce(max(number), 0) + 1 as next from orders where establishment_id = ${ctx.establishmentId}`;
    const [order] = await tx`
      insert into orders (establishment_id, account_id, number, source, waiter_id, user_id, client_request_id, note)
      values (${ctx.establishmentId}, ${accountId}, ${next}, ${ctx.source}, ${ctx.waiterId}, ${ctx.userId}, ${input.clientRequestId}, ${input.note})
      returning id, number`;

    for (const l of lines) {
      await tx`
        insert into order_items (order_id, product_id, name, option, unit_cents, vat_rate, qty, destination, course, status)
        values (${order.id}, ${l.p.id}, ${l.p.name}, ${l.option}, ${l.p.price_cents}, ${l.p.vat_rate}, ${l.qty},
                ${l.p.destination}, ${l.course}, ${l.course === minCourse ? 'new' : 'held'})`;
    }

    await tx`
      update tables set physical_state = 'occupied'
      where id = (select table_id from accounts where id = ${accountId}) and physical_state = 'free'`;

    return { orderId: order.id, number: order.number, accountId, duplicate: false };
  });
}

async function resolveAccount(tx: Tx, target: OrderInput['target'], ctx: OrderContext): Promise<string> {
  if ('accountId' in target) {
    const [a] = await tx`select id, status from accounts where id = ${target.accountId} and establishment_id = ${ctx.establishmentId} for update`;
    if (!a) throw notFound('Cuenta');
    if (a.status !== 'open') throw conflict('account_closed', 'La cuenta ya está cerrada');
    return a.id;
  }
  if ('tableId' in target) return openTableAccount(tx, ctx.establishmentId, target.tableId, ctx.waiterId);
  if (ctx.source === 'client') throw badRequest('Pedido no permitido');
  return openBarAccount(tx, ctx.establishmentId, target.barName, ctx.waiterId);
}

/** Transiciones permitidas. Cocina/barra: new → preparing → ready. Sala: ready → received → delivered. */
const TRANSITIONS: Record<string, string[]> = {
  held: ['new', 'cancelled'],
  new: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'new', 'cancelled'],
  ready: ['received', 'delivered', 'preparing'],
  received: ['delivered', 'ready'],
  delivered: [],
  cancelled: [],
};

export async function setItemsStatus(establishmentId: string, itemIds: string[], status: string) {
  return sql.begin(async (tx) => {
    const items = await tx`
      select i.id, i.status, i.name, a.status as account_status
      from order_items i join orders o on o.id = i.order_id join accounts a on a.id = o.account_id
      where i.id in ${tx(itemIds)} and o.establishment_id = ${establishmentId}
      for update of i`;
    if (items.length !== itemIds.length) throw notFound('Producto del pedido');
    for (const it of items) {
      if (it.status === status) continue;
      if (!TRANSITIONS[it.status]?.includes(status)) {
        throw conflict('invalid_transition', `«${it.name}» no puede pasar de ${it.status} a ${status}`);
      }
      if (status === 'cancelled' && it.account_status !== 'open') {
        throw conflict('account_closed', 'No se puede anular un producto de una cuenta cerrada');
      }
    }
    await tx`
      update order_items set status = ${status}, updated_at = now(),
        ready_at = case when ${status} = 'ready' then now() else ready_at end,
        delivered_at = case when ${status} = 'delivered' then now() else delivered_at end
      where id in ${tx(itemIds)} and status <> ${status}`;
    const accounts = await tx`
      select distinct o.account_id, t.qr_token from order_items i join orders o on o.id = i.order_id
      join accounts a on a.id = o.account_id left join tables t on t.id = a.table_id
      where i.id in ${tx(itemIds)}`;
    return accounts.map((a) => ({ accountId: a.account_id as string, tableToken: a.qr_token as string | null }));
  });
}

/** "Marchar ahora": libera el siguiente pase retenido de la cuenta. */
export async function fireNextCourse(establishmentId: string, accountId: string): Promise<number | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx`
      select min(i.course) as course from order_items i join orders o on o.id = i.order_id
      where o.account_id = ${accountId} and o.establishment_id = ${establishmentId} and i.status = 'held'`;
    if (row?.course == null) return null;
    await tx`
      update order_items i set status = 'new', updated_at = now()
      from orders o where o.id = i.order_id and o.account_id = ${accountId} and i.status = 'held' and i.course = ${row.course}`;
    return row.course as number;
  });
}
