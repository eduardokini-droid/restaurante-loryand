import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { actorLabel, establishmentOf, requireModule } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { audit } from '../services/audit.js';
import { looksExcessive, productCosts, toItemUnit, type Unit } from '../services/stock.js';

const unit = z.enum(['ud', 'kg', 'g', 'l', 'ml']);
const itemSchema = z.object({
  name: z.string().min(1).max(100),
  unit,
  productId: z.string().uuid().nullable().default(null),
  packQty: z.number().positive().nullable().default(null),
  packUnit: z.enum(['kg', 'g', 'l', 'ml']).nullable().default(null),
  minStock: z.number().min(0).nullable().default(null),
  costPerUnitCents: z.number().min(0).default(0),
  stock: z.number().default(0),
}).refine((v) => (v.packQty == null) === (v.packUnit == null), 'indica cantidad y unidad del envase, o ninguna')
  .refine((v) => v.packQty == null || v.unit === 'ud', 'el contenido del envase solo se usa con artículos contados en unidades');

export default async function stockRoutes(app: FastifyInstance) {
  app.get('/api/stock/items', async (req) => {
    requireModule(req, 'stock');
    const est = establishmentOf(req);
    return sql`
      select s.*, p.name as product_name,
             (s.min_stock is not null and s.stock < s.min_stock) as low,
             round(s.stock * s.cost_per_unit)::int as value_cents
      from stock_items s left join products p on p.id = s.product_id
      where s.establishment_id = ${est} and not s.archived order by s.name`;
  });

  app.post('/api/stock/items', async (req) => {
    const a = requireModule(req, 'stock');
    const est = establishmentOf(req);
    const b = parse(itemSchema, req.body);
    if (b.productId) {
      const [p] = await sql`select 1 from products where id = ${b.productId} and establishment_id = ${est}`;
      if (!p) throw notFound('Producto');
      const [dup] = await sql`select name from stock_items where product_id = ${b.productId} and not archived`;
      if (dup) throw conflict('duplicate', `Ese producto ya está en el almacén como «${dup.name}»`);
    }
    const [dupName] = await sql`select 1 from stock_items where establishment_id = ${est} and lower(name) = lower(${b.name}) and not archived`;
    if (dupName) throw conflict('duplicate', 'Ya existe un artículo con ese nombre');
    return sql.begin(async (tx) => {
      const [s] = await tx`
        insert into stock_items (establishment_id, product_id, name, unit, pack_qty, pack_unit, stock, min_stock, cost_per_unit)
        values (${est}, ${b.productId}, ${b.name}, ${b.unit}, ${b.packQty}, ${b.packUnit}, ${b.stock}, ${b.minStock}, ${b.costPerUnitCents})
        returning *`;
      if (b.stock) await tx`insert into stock_movements (establishment_id, item_id, kind, qty, reference, actor) values (${est}, ${s.id}, 'adjustment', ${b.stock}, 'Inventario inicial', ${actorLabel(a)})`;
      return s;
    });
  });

  app.patch('/api/stock/items/:id', async (req) => {
    requireModule(req, 'stock');
    const est = establishmentOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({
      name: z.string().min(1).max(100), minStock: z.number().min(0).nullable(), costPerUnitCents: z.number().min(0),
      packQty: z.number().positive().nullable(), packUnit: z.enum(['kg', 'g', 'l', 'ml']).nullable(), archived: z.boolean(),
    }).partial(), req.body);
    const cols: Record<string, unknown> = {};
    if (b.name) cols.name = b.name;
    if (b.minStock !== undefined) cols.min_stock = b.minStock;
    if (b.costPerUnitCents !== undefined) cols.cost_per_unit = b.costPerUnitCents;
    if (b.packQty !== undefined) cols.pack_qty = b.packQty;
    if (b.packUnit !== undefined) cols.pack_unit = b.packUnit;
    if (b.archived !== undefined) cols.archived = b.archived;
    const [s] = await sql`update stock_items set ${sql(cols)} where id = ${id} and establishment_id = ${est} returning *`;
    if (!s) throw notFound('Artículo');
    return s;
  });

  /** Compras, mermas y correcciones. La venta descuenta sola según el escandallo. */
  app.post('/api/stock/movements', async (req) => {
    const a = requireModule(req, 'stock');
    const est = establishmentOf(req);
    const b = parse(z.object({
      itemId: z.string().uuid(),
      kind: z.enum(['purchase', 'waste', 'adjustment']),
      qty: z.number().min(0),               // compra/merma: cantidad; corrección: existencias contadas
      unitCostCents: z.number().min(0).nullish(),
      supplier: z.string().max(100).default(''),
      reference: z.string().max(200).default(''),
    }), req.body);
    return sql.begin(async (tx) => {
      const [it] = await tx`select * from stock_items where id = ${b.itemId} and establishment_id = ${est} and not archived for update`;
      if (!it) throw notFound('Artículo');
      const stock = Number(it.stock);
      let delta: number;
      if (b.kind === 'purchase') {
        if (b.qty <= 0) throw badRequest('Indica la cantidad comprada');
        delta = b.qty;
        if (b.unitCostCents != null) {
          // Coste medio ponderado con lo que ya había en el almacén.
          const base = Math.max(stock, 0);
          const avg = base > 0 ? (base * Number(it.cost_per_unit) + b.qty * b.unitCostCents) / (base + b.qty) : b.unitCostCents;
          await tx`update stock_items set cost_per_unit = ${Math.round(avg * 10000) / 10000} where id = ${it.id}`;
        }
      } else if (b.kind === 'waste') {
        if (b.qty <= 0) throw badRequest('Indica la cantidad perdida');
        delta = -b.qty;
      } else {
        delta = b.qty - stock;
        if (delta === 0) throw badRequest('Las existencias contadas coinciden con las registradas');
      }
      await tx`update stock_items set stock = stock + ${delta} where id = ${it.id}`;
      const [m] = await tx`
        insert into stock_movements (establishment_id, item_id, kind, qty, unit_cost, supplier, reference, actor)
        values (${est}, ${it.id}, ${b.kind}, ${delta}, ${b.unitCostCents ?? null}, ${b.supplier}, ${b.reference}, ${actorLabel(a)})
        returning *`;
      await audit(tx, est, actorLabel(a), `stock.${b.kind}`, { itemId: it.id, delta });
      return m;
    });
  });

  app.get('/api/stock/movements', async (req) => {
    requireModule(req, 'stock');
    const est = establishmentOf(req);
    const q = parse(z.object({ itemId: z.string().uuid().optional() }), req.query);
    return sql`
      select m.id, m.kind, m.qty, m.unit_cost, m.supplier, m.reference, m.created_at, s.name as item_name, s.unit
      from stock_movements m join stock_items s on s.id = m.item_id
      where m.establishment_id = ${est} and (${q.itemId ?? null}::uuid is null or m.item_id = ${q.itemId ?? null})
      order by m.created_at desc, m.id desc limit 100`;
  });

  // ---------- Escandallos ----------
  app.get('/api/stock/recipes/:productId', async (req) => {
    requireModule(req, 'stock');
    const est = establishmentOf(req);
    const { productId } = parse(z.object({ productId: z.string().uuid() }), req.params);
    const [p] = await sql`select id, name, price_cents, vat_rate from products where id = ${productId} and establishment_id = ${est}`;
    if (!p) throw notFound('Producto');
    const lines = await sql`
      select r.item_id, r.qty, r.unit, s.name, s.unit as item_unit, s.pack_qty, s.pack_unit, s.cost_per_unit
      from recipe_lines r join stock_items s on s.id = r.item_id where r.product_id = ${productId} order by s.name`;
    return {
      product: p,
      lines: lines.map((l) => {
        const q = toItemUnit(Number(l.qty), l.unit, { name: l.name, unit: l.item_unit, pack_qty: l.pack_qty, pack_unit: l.pack_unit });
        return { ...l, itemQty: q, costCents: q * Number(l.cost_per_unit) };
      }),
    };
  });

  app.put('/api/stock/recipes/:productId', async (req) => {
    const a = requireModule(req, 'stock');
    const est = establishmentOf(req);
    const { productId } = parse(z.object({ productId: z.string().uuid() }), req.params);
    const b = parse(z.object({
      lines: z.array(z.object({ itemId: z.string().uuid(), qty: z.number().positive(), unit })).max(50),
      confirmLarge: z.boolean().default(false),
    }), req.body);
    const [p] = await sql`select id from products where id = ${productId} and establishment_id = ${est}`;
    if (!p) throw notFound('Producto');
    const ids = b.lines.map((l) => l.itemId);
    if (new Set(ids).size !== ids.length) throw badRequest('Un ingrediente aparece dos veces');
    const items = ids.length ? await sql`select id, name, unit, pack_qty, pack_unit from stock_items where establishment_id = ${est} and id in ${sql(ids)} and not archived` : [];
    const warnings: string[] = [];
    for (const l of b.lines) {
      const it = items.find((x) => x.id === l.itemId);
      if (!it) throw notFound('Ingrediente');
      const q = toItemUnit(l.qty, l.unit as Unit, { name: it.name, unit: it.unit, pack_qty: it.pack_qty, pack_unit: it.pack_unit });
      if (looksExcessive(q, { name: it.name, unit: it.unit, pack_qty: it.pack_qty, pack_unit: it.pack_unit })) {
        warnings.push(`${l.qty} ${l.unit} de «${it.name}» por cada unidad vendida`);
      }
    }
    if (warnings.length && !b.confirmLarge) {
      throw conflict('confirm_large', `Revisa las unidades: ${warnings.join('; ')}. ¿Seguro que no son ml o g?`);
    }
    await sql.begin(async (tx) => {
      await tx`delete from recipe_lines where product_id = ${productId}`;
      for (const l of b.lines) await tx`insert into recipe_lines (product_id, item_id, qty, unit) values (${productId}, ${l.itemId}, ${l.qty}, ${l.unit})`;
      await audit(tx, est, actorLabel(a), 'recipe.save', { productId, lines: b.lines.length });
    });
    return { ok: true };
  });

  /** Rentabilidad: venta sin IVA, coste según escandallo, margen. No es el beneficio neto del negocio. */
  app.get('/api/reports/profitability', async (req) => {
    requireModule(req, 'stock');
    const est = establishmentOf(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date() }), req.query);
    const sales = await sql`
      select p.id, p.name, sum(i.qty)::int as sold,
             sum(round(i.unit_cents * i.qty / (1 + i.vat_rate / 100)))::int as net_cents
      from order_items i join orders o on o.id = i.order_id join products p on p.id = i.product_id
      where o.establishment_id = ${est} and i.status <> 'cancelled'
        and o.created_at between ${q.from + 'T00:00:00'}::timestamp and ${q.to + 'T23:59:59.999'}::timestamp
      group by p.id order by net_cents desc`;
    const costs = await productCosts(sql as never, est);
    return sales.map((s) => {
      const c = costs.get(s.id);
      const costCents = c ? Math.round(c.cost * s.sold) : null;
      const margin = costCents == null ? null : s.net_cents - costCents;
      return {
        ...s, costCents, marginCents: margin,
        marginPct: margin == null || s.net_cents === 0 ? null : Math.round((margin / s.net_cents) * 1000) / 10,
        recipe: c ? (c.complete ? 'complete' : 'missing_costs') : 'none',
      };
    });
  });
}
