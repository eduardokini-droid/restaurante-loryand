import { z } from 'zod';
import { sql, type Tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { openBarAccount, openTableAccount } from './accounts.js';
import { activeMenu, menuChoice, SECTION_LABEL, SECTION_ROUTE, validateChoice } from './menu.js';
import { setPhysicalState } from './tables.js';
import { consumeForItems } from './stock.js';

export const orderInput = z.object({
  clientRequestId: z.string().min(8).max(100),
  target: z.union([
    z.object({ accountId: z.string().uuid() }),
    z.object({ tableId: z.string().uuid() }),
    z.object({ barName: z.string().min(1).max(60) }),
  ]),
  items: z.array(z.union([
    z.object({
      productId: z.string().uuid(),
      qty: z.number().int().min(1).max(99),
      option: z.string().max(90).nullish(),
      course: z.number().int().min(1).max(5).nullish(),
    }),
    // Un menú del día por persona: cada uno con sus elecciones.
    z.object({ menu: menuChoice }),
  ])).min(1).max(100),
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

    const productItems = input.items.filter((i): i is Extract<typeof i, { productId: string }> => 'productId' in i);
    const menuItems = input.items.filter((i): i is Extract<typeof i, { menu: unknown }> => 'menu' in i);

    const ids = [...new Set(productItems.map((i) => i.productId))];
    const products = ids.length ? await tx`
      select id, name, price_cents, vat_rate, destination, course, options, visible
      from products
      where establishment_id = ${ctx.establishmentId} and id in ${tx(ids)} and not archived` : [];
    const byId = new Map(products.map((p) => [p.id, p]));

    const lines = productItems.map((item) => {
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

    const menu = menuItems.length ? await activeMenu(tx, ctx.establishmentId) : undefined;
    if (menuItems.length && !menu) throw badRequest('El menú del día no está disponible ahora');
    const menus = menuItems.map((m) => validateChoice(menu!, m.menu));

    const courses = [...lines.map((l) => l.course), ...menus.flatMap((parts) => parts.map((x) => SECTION_ROUTE[x.section].course))];
    const minCourse = Math.min(...courses);
    const statusFor = (course: number) => (course === minCourse ? 'new' : 'held');

    const [{ next }] = await tx`
      select coalesce(max(number), 0) + 1 as next from orders where establishment_id = ${ctx.establishmentId}`;
    const [order] = await tx`
      insert into orders (establishment_id, account_id, number, source, waiter_id, user_id, client_request_id, note)
      values (${ctx.establishmentId}, ${accountId}, ${next}, ${ctx.source}, ${ctx.waiterId}, ${ctx.userId}, ${input.clientRequestId}, ${input.note})
      returning id, number`;

    const sold: Array<{ id: string; product_id: string; qty: number }> = [];
    for (const l of lines) {
      const [row] = await tx`
        insert into order_items (order_id, product_id, name, option, unit_cents, vat_rate, qty, destination, course, status)
        values (${order.id}, ${l.p.id}, ${l.p.name}, ${l.option}, ${l.p.price_cents}, ${l.p.vat_rate}, ${l.qty},
                ${l.p.destination}, ${l.course}, ${statusFor(l.course)})
        returning id`;
      sold.push({ id: row.id, product_id: l.p.id, qty: l.qty });
    }
    // Descuenta del almacén según escandallo (o el artículo vinculado al producto).
    await consumeForItems(tx, ctx.establishmentId, sold);
    for (const parts of menus) {
      // Cabecera: lleva el precio y no va a ningún puesto. Componentes: a cocina o barra, precio 0.
      const [head] = await tx`
        insert into order_items (order_id, name, option, unit_cents, vat_rate, qty, destination, course, status)
        values (${order.id}, ${menu!.name}, null, ${menu!.price_cents}, ${menu!.vat_rate}, 1, 'none', ${minCourse}, 'new')
        returning id`;
      for (const part of parts) {
        const r = SECTION_ROUTE[part.section];
        await tx`
          insert into order_items (order_id, parent_item_id, name, option, unit_cents, vat_rate, qty, destination, course, status)
          values (${order.id}, ${head.id}, ${part.value}, ${`${menu!.name} · ${SECTION_LABEL[part.section]}`}, 0, ${menu!.vat_rate}, 1,
                  ${r.destination}, ${r.course}, ${statusFor(r.course)})`;
      }
    }

    const [acc] = await tx`select table_id from accounts where id = ${accountId}`;
    if (acc?.table_id) {
      const [t] = await tx`select physical_state from tables where id = ${acc.table_id}`;
      if (t.physical_state === 'free') await setPhysicalState(tx, acc.table_id, 'occupied');
    }

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
  new: ['preparing', 'ready', 'delivered', 'cancelled'],  // delivered: servido directamente (p. ej. barra)
  preparing: ['ready', 'new', 'delivered', 'cancelled'],
  ready: ['received', 'delivered', 'preparing'],
  received: ['delivered', 'ready'],
  delivered: [],
  cancelled: [],
};

export async function setItemsStatus(establishmentId: string, itemIds: string[], status: string) {
  itemIds = [...itemIds];
  return sql.begin(async (tx) => {
    const items = await tx`
      select i.id, i.status, i.name, i.destination, i.product_id, i.qty, a.status as account_status
      from order_items i join orders o on o.id = i.order_id join accounts a on a.id = o.account_id
      where i.id in ${tx(itemIds)} and o.establishment_id = ${establishmentId}
      for update of i`;
    if (items.length !== itemIds.length) throw notFound('Producto del pedido');
    // Anular la cabecera de un menú anula también sus platos pendientes.
    if (status === 'cancelled') {
      const children = await tx`select id, status, name, 'open' as account_status from order_items where parent_item_id in ${tx(itemIds)} and status <> 'cancelled' for update`;
      for (const c of children) if (!itemIds.includes(c.id)) { items.push(c); itemIds = [...itemIds, c.id]; }
    }
    const heads = items.filter((i) => i.destination === 'none');
    if (heads.length && status !== 'cancelled') throw conflict('invalid_transition', 'El menú se sirve plato a plato: cambia el estado de cada plato');
    for (const it of items) {
      if (it.status === status) continue;
      if (!TRANSITIONS[it.status]?.includes(status)) {
        throw conflict('invalid_transition', `«${it.name}» no puede pasar de ${it.status} a ${status}`);
      }
      if (status === 'cancelled' && it.account_status !== 'open') {
        throw conflict('account_closed', 'No se puede anular un producto de una cuenta cerrada');
      }
    }
    if (status === 'cancelled') {
      // Lo anulado vuelve al almacén.
      const back = items.filter((i) => i.status !== 'cancelled' && i.product_id).map((i) => ({ id: i.id, product_id: i.product_id, qty: i.qty }));
      await consumeForItems(tx, establishmentId, back, true);
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
