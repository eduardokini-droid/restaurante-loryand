import type { Tx } from '../db.js';
import { badRequest } from '../errors.js';

export type Unit = 'ud' | 'kg' | 'g' | 'l' | 'ml';
const FAMILY: Record<Unit, 'mass' | 'volume' | 'count'> = { kg: 'mass', g: 'mass', l: 'volume', ml: 'volume', ud: 'count' };
const FACTOR: Record<Unit, number> = { kg: 1000, g: 1, l: 1000, ml: 1, ud: 1 };
export const UNIT_LABEL: Record<Unit, string> = { ud: 'unidades', kg: 'kg', g: 'g', l: 'litros', ml: 'ml' };

export interface StockItemUnits { name: string; unit: Unit; pack_qty: string | number | null; pack_unit: Unit | null }

/**
 * Convierte una cantidad a la unidad del artículo. Ejemplos:
 *  - 30 ml de un artículo en litros → 0,03
 *  - 50 ml de una botella (ud) de 0,7 l → 0,0714 ud
 *  - 2 ud de un artículo en kg → error: unidades incompatibles
 */
export function toItemUnit(qty: number, from: Unit, item: StockItemUnits): number {
  if (from === item.unit) return qty;
  if (FAMILY[from] === FAMILY[item.unit]) return (qty * FACTOR[from]) / FACTOR[item.unit];
  if (item.unit === 'ud' && item.pack_qty && item.pack_unit && FAMILY[from] === FAMILY[item.pack_unit]) {
    return (qty * FACTOR[from]) / FACTOR[item.pack_unit] / Number(item.pack_qty);
  }
  const hint = item.unit === 'ud' ? ' Indica el contenido del envase (p. ej. 1 ud = 0,7 l) para usar litros o ml.' : '';
  throw badRequest(`«${item.name}» se cuenta en ${UNIT_LABEL[item.unit]}: no se puede usar ${UNIT_LABEL[from]}.${hint}`);
}

/** Una cantidad por venta así de grande casi siempre es un error de unidad (30 l en vez de 30 ml). */
export function looksExcessive(itemQtyPerSale: number, item: StockItemUnits): boolean {
  const limit = { kg: 2, l: 2, g: 2000, ml: 2000, ud: 10 }[item.unit];
  return itemQtyPerSale > limit;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Descuenta del almacén lo vendido: si el producto tiene escandallo, sus ingredientes;
 * si no, y está vinculado a un artículo de almacén, una unidad de ese artículo.
 */
export async function consumeForItems(tx: Tx, establishmentId: string, items: Array<{ id: string; product_id: string | null; qty: number }>, reverse = false) {
  for (const it of items) {
    if (!it.product_id) continue;
    let lines = await tx`
      select r.qty, r.unit, s.id as item_id, s.name, s.unit as item_unit, s.pack_qty, s.pack_unit
      from recipe_lines r join stock_items s on s.id = r.item_id
      where r.product_id = ${it.product_id} and not s.archived`;
    if (!lines.length) {
      lines = await tx`select 1 as qty, unit, id as item_id, name, unit as item_unit, pack_qty, pack_unit
                       from stock_items where product_id = ${it.product_id} and not archived`;
    }
    for (const l of lines) {
      // Una receta incoherente nunca debe impedir servir una comanda: esa línea se omite.
      let perSale: number;
      try { perSale = toItemUnit(Number(l.qty), l.unit, { name: l.name, unit: l.item_unit, pack_qty: l.pack_qty, pack_unit: l.pack_unit }); } catch { continue; }
      const qty = round4(perSale * it.qty) * (reverse ? 1 : -1);
      await tx`update stock_items set stock = stock + ${qty} where id = ${l.item_id}`;
      await tx`insert into stock_movements (establishment_id, item_id, kind, qty, order_item_id)
               values (${establishmentId}, ${l.item_id}, ${reverse ? 'sale_reversal' : 'sale'}, ${qty}, ${it.id})`;
    }
  }
}

/** Coste actual de una unidad vendida del producto, en céntimos (según escandallo y costes registrados). */
export async function productCosts(tx: Tx, establishmentId: string): Promise<Map<string, { cost: number; complete: boolean }>> {
  const rows = await tx`
    select p.id as product_id, r.qty, r.unit, s.name, s.unit as item_unit, s.pack_qty, s.pack_unit, s.cost_per_unit
    from products p
    join recipe_lines r on r.product_id = p.id
    join stock_items s on s.id = r.item_id
    where p.establishment_id = ${establishmentId}
    union all
    select s.product_id, 1, s.unit, s.name, s.unit, s.pack_qty, s.pack_unit, s.cost_per_unit
    from stock_items s
    where s.establishment_id = ${establishmentId} and s.product_id is not null and not s.archived
      and not exists (select 1 from recipe_lines r where r.product_id = s.product_id)`;
  const out = new Map<string, { cost: number; complete: boolean }>();
  for (const r of rows) {
    const cur = out.get(r.product_id) ?? { cost: 0, complete: true };
    const q = toItemUnit(Number(r.qty), r.unit, { name: r.name, unit: r.item_unit, pack_qty: r.pack_qty, pack_unit: r.pack_unit });
    cur.cost += q * Number(r.cost_per_unit);
    if (Number(r.cost_per_unit) === 0) cur.complete = false;
    out.set(r.product_id, cur);
  }
  return out;
}
