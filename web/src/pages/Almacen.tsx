import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { dateTime, money, today, toCents } from '../lib/format';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';

const UNITS: Record<string, string> = { ud: 'unidades', kg: 'kg', g: 'g', l: 'litros', ml: 'ml' };
const KIND: Record<string, string> = { purchase: 'Compra', waste: 'Merma', adjustment: 'Corrección', sale: 'Venta', sale_reversal: 'Anulación' };
const num = (v: string | number, d = 3) => Number(v).toLocaleString('es-ES', { maximumFractionDigits: d });
const parseNum = (v: string) => parseFloat(v.replace(',', '.'));

export default function Almacen() {
  const [tab, setTab] = useState<'stock' | 'moves' | 'recipes' | 'profit'>('stock');
  const [items, setItems] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const load = useCallback(() => {
    api('/api/stock/items').then(setItems).catch(() => {});
    api('/api/admin/products').then(setProducts).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const low = items.filter((i) => i.low);
  const value = items.reduce((s, i) => s + i.value_cents, 0);
  return (
    <div className="stack">
      <h1>Almacén y rentabilidad</h1>
      <div className="grid cols-2">
        <div className="card"><div className="muted small">Valor del almacén</div><h2>{money(value)}</h2></div>
        <div className="card"><div className="muted small">Bajo mínimos</div><h2 style={{ color: low.length ? 'var(--terra)' : undefined }}>{low.length}</h2>
          <div className="small">{low.map((i) => i.name).join(', ')}</div></div>
      </div>
      <div className="chips">
        {([['stock', 'Existencias'], ['moves', 'Compras y mermas'], ['recipes', 'Escandallos'], ['profit', 'Rentabilidad']] as const).map(([k, l]) => (
          <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'stock' && <Stock items={items} products={products} onChange={load} />}
      {tab === 'moves' && <Moves items={items} onChange={load} />}
      {tab === 'recipes' && <Recipes items={items} products={products} />}
      {tab === 'profit' && <Profit />}
    </div>
  );
}

function Stock({ items, products, onChange }: { items: any[]; products: any[]; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <div className="spread"><h3 style={{ margin: 0 }}>Existencias</h3><button className="btn primary small" onClick={() => setAdding(true)}>+ Añadir artículo</button></div>
      <table className="list mt">
        <thead><tr><th>Artículo</th><th className="right">Stock</th><th className="right">Mínimo</th><th className="right">Coste</th><th className="right">Valor</th></tr></thead>
        <tbody>{items.map((i) => (
          <tr key={i.id}>
            <td><strong>{i.name}</strong>{i.product_name && <div className="small muted">Se vende como «{i.product_name}»</div>}
              {i.pack_qty && <div className="small muted">1 ud = {num(i.pack_qty)} {UNITS[i.pack_unit]}</div>}</td>
            <td className="right" style={{ color: i.low ? 'var(--terra)' : undefined }}><strong>{num(i.stock)}</strong> {UNITS[i.unit]}{i.low && <div className="badge danger">Reponer</div>}</td>
            <td className="right">{i.min_stock != null ? num(i.min_stock) : <span className="small muted">sin mínimo</span>}</td>
            <td className="right">{money(Number(i.cost_per_unit))}/{i.unit === 'ud' ? 'ud' : i.unit}</td>
            <td className="right">{money(i.value_cents)}</td>
          </tr>
        ))}</tbody>
      </table>
      {items.length === 0 && <p className="muted">Añade las materias primas (harina, aceite…) y las bebidas que quieras controlar.</p>}
      {adding && <AddItem products={products} onClose={() => setAdding(false)} onDone={() => { setAdding(false); onChange(); }} />}
    </div>
  );
}

function AddItem({ products, onClose, onDone }: { products: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', unit: 'kg', productId: '', packQty: '', packUnit: 'l', stock: '', minStock: '', cost: '' });
  const { busy, error, run } = useAction();
  const save = () => run(async () => {
    await api('/api/stock/items', { body: {
      name: f.name, unit: f.unit, productId: f.productId || null,
      packQty: f.unit === 'ud' && f.packQty ? parseNum(f.packQty) : null, packUnit: f.unit === 'ud' && f.packQty ? f.packUnit : null,
      stock: f.stock ? parseNum(f.stock) : 0, minStock: f.minStock ? parseNum(f.minStock) : null, costPerUnitCents: f.cost ? toCents(f.cost) : 0,
    } });
    onDone();
  });
  return (
    <Modal title="Añadir artículo al almacén" onClose={onClose}>
      <label>¿Es un producto de la carta que se vende tal cual? (p. ej. una botella de vino)
        <select value={f.productId} onChange={(e) => { const p = products.find((x) => x.id === e.target.value); setF({ ...f, productId: e.target.value, name: p ? p.name : f.name, unit: p ? 'ud' : f.unit }); }}>
          <option value="">No: es una materia prima o ingrediente</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label>Se cuenta en<select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{Object.entries(UNITS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Stock actual ({UNITS[f.unit]})<input inputMode="decimal" value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value })} /></label>
        <label>Mínimo de aviso<input inputMode="decimal" value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value })} /></label>
        <label>Coste por {f.unit === 'ud' ? 'unidad' : f.unit} (€)<input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></label>
      </div>
      {f.unit === 'ud' && (
        <div className="row">
          <span className="small">Contenido de 1 unidad (opcional, para recetas en ml o g):</span>
          <input style={{ maxWidth: 90 }} inputMode="decimal" placeholder="0,7" value={f.packQty} onChange={(e) => setF({ ...f, packQty: e.target.value })} />
          <select style={{ maxWidth: 110 }} value={f.packUnit} onChange={(e) => setF({ ...f, packUnit: e.target.value })}>{['l', 'ml', 'kg', 'g'].map((u) => <option key={u} value={u}>{UNITS[u]}</option>)}</select>
        </div>
      )}
      <p className="small muted">El coste es por unidad, no el total de la compra.</p>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !f.name} onClick={save}>Añadir</button>
    </Modal>
  );
}

function Moves({ items, onChange }: { items: any[]; onChange: () => void }) {
  const [moves, setMoves] = useState<any[]>([]);
  const [f, setF] = useState({ itemId: '', kind: 'purchase', qty: '', cost: '', supplier: '', reference: '' });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => { api('/api/stock/movements').then(setMoves).catch(() => {}); }, []);
  useEffect(load, [load]);
  const item = items.find((i) => i.id === f.itemId);
  const save = () => run(async () => {
    await api('/api/stock/movements', { body: { itemId: f.itemId, kind: f.kind, qty: parseNum(f.qty), unitCostCents: f.kind === 'purchase' && f.cost ? toCents(f.cost) : null, supplier: f.supplier, reference: f.reference } });
    toast('Movimiento registrado'); setF({ ...f, qty: '', cost: '', reference: '' }); load(); onChange();
  });
  return (
    <div className="stack">
      <div className="card">
        <h3>Registrar nuevas compras o mermas</h3>
        <div className="grid cols-2">
          <label>Artículo<select value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">Elige…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
          <label>Tipo<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="purchase">Nueva compra / entrada</option><option value="waste">Rotura, desperdicio o merma</option><option value="adjustment">Corrección de stock (recuento)</option></select></label>
          <label>{f.kind === 'adjustment' ? 'Existencias contadas' : 'Cantidad'}{item && ` (${UNITS[item.unit]})`}<input inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
          {f.kind === 'purchase' && <label>Coste de cada unidad (€){item && ` por ${item.unit}`}<input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></label>}
          {f.kind === 'purchase' && <label>Proveedor<input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></label>}
          <label>{f.kind === 'purchase' ? 'Referencia de factura' : 'Motivo'}<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
        </div>
        {item && f.kind === 'adjustment' && <p className="small muted">Registrado ahora: {num(item.stock)} {UNITS[item.unit]}. Usa la corrección solo tras un recuento revisado.</p>}
        <ErrorText error={error} />
        <button className="btn primary" disabled={busy || !f.itemId || !f.qty} onClick={save}>Registrar movimiento</button>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <h3>Últimos movimientos</h3>
        <table className="list">
          <thead><tr><th>Fecha</th><th>Artículo</th><th>Tipo</th><th className="right">Cantidad</th><th>Detalle</th></tr></thead>
          <tbody>{moves.map((m) => (
            <tr key={m.id}><td className="small">{dateTime(m.created_at)}</td><td>{m.item_name}</td><td>{KIND[m.kind]}</td>
              <td className="right" style={{ color: Number(m.qty) < 0 ? 'var(--terra)' : 'var(--ok)' }}>{Number(m.qty) > 0 ? '+' : ''}{num(m.qty)} {m.unit}</td>
              <td className="small">{[m.supplier, m.reference, m.unit_cost != null && `${money(Number(m.unit_cost))}/ud`].filter(Boolean).join(' · ')}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Recipes({ items, products }: { items: any[]; products: any[] }) {
  const [productId, setProductId] = useState('');
  const [data, setData] = useState<any>(null);
  const [lines, setLines] = useState<{ itemId: string; qty: string; unit: string }[]>([]);
  const { busy, error, setError, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    if (!productId) return;
    api(`/api/stock/recipes/${productId}`).then((d) => { setData(d); setLines(d.lines.map((l: any) => ({ itemId: l.item_id, qty: String(Number(l.qty)).replace('.', ','), unit: l.unit }))); }).catch(() => {});
  }, [productId]);
  const save = (confirmLarge = false): Promise<void> => run(async () => {
    try {
      await api(`/api/stock/recipes/${productId}`, { method: 'PUT', body: { lines: lines.filter((l) => l.itemId && l.qty).map((l) => ({ itemId: l.itemId, qty: parseNum(l.qty), unit: l.unit })), confirmLarge } });
      toast('Escandallo guardado');
      setData(await api(`/api/stock/recipes/${productId}`));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_large' && confirm(e.message)) { setError(null); await save(true); return; }
      throw e;
    }
  }).then(() => undefined);
  const cost = data?.lines.reduce((s: number, l: any) => s + l.costCents, 0) ?? 0;
  const net = data ? Math.round(data.product.price_cents / (1 + Number(data.product.vat_rate) / 100)) : 0;
  return (
    <div className="card stack">
      <label>Producto<select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">Elige un producto de la carta…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {data && (
        <>
          <p className="small muted">Cantidad de cada ingrediente por unidad vendida. Revisa las unidades: 30 ml son 0,03 litros, no 30 litros.</p>
          {lines.map((l, i) => (
            <div key={i} className="row">
              <select style={{ maxWidth: 260 }} value={l.itemId} onChange={(e) => setLines(lines.map((x, k) => k === i ? { ...x, itemId: e.target.value } : x))}>
                <option value="">Ingrediente…</option>{items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}</select>
              <input style={{ maxWidth: 100 }} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, k) => k === i ? { ...x, qty: e.target.value } : x))} />
              <select style={{ maxWidth: 110 }} value={l.unit} onChange={(e) => setLines(lines.map((x, k) => k === i ? { ...x, unit: e.target.value } : x))}>{Object.entries(UNITS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <button className="btn small ghost" onClick={() => setLines(lines.filter((_, k) => k !== i))}>✕</button>
            </div>
          ))}
          <div className="row">
            <button className="btn small" onClick={() => setLines([...lines, { itemId: '', qty: '', unit: 'g' }])}>+ Ingrediente</button>
            <button className="btn primary small" disabled={busy} onClick={() => save()}>Guardar escandallo</button>
          </div>
          <ErrorText error={error} />
          {data.lines.length > 0 && (
            <div className="card">
              <div className="spread"><span>Venta sin IVA</span><strong>{money(net)}</strong></div>
              <div className="spread"><span>Coste según escandallo</span><strong>{money(Math.round(cost))}</strong></div>
              <div className="spread"><span>Margen</span><strong>{money(net - Math.round(cost))} ({net ? Math.round(((net - cost) / net) * 100) : 0} %)</strong></div>
              {data.lines.some((l: any) => Number(l.cost_per_unit) === 0) && <p className="notice small">Algún ingrediente tiene coste 0: el margen será engañoso.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Profit() {
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); });
  const [to, setTo] = useState(today());
  const [rows, setRows] = useState<any[]>([]);
  const load = useCallback(() => { api(`/api/reports/profitability?from=${from}&to=${to}`).then(setRows).catch(() => {}); }, [from, to]);
  useEffect(load, [load]);
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <div className="row"><input type="date" style={{ maxWidth: 170 }} value={from} onChange={(e) => setFrom(e.target.value)} /> a <input type="date" style={{ maxWidth: 170 }} value={to} onChange={(e) => setTo(e.target.value)} /></div>
      <table className="list mt">
        <thead><tr><th>Producto</th><th className="right">Vendidos</th><th className="right">Venta sin IVA</th><th className="right">Coste</th><th className="right">Margen</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td>{r.name}{r.recipe === 'none' && <div className="small muted">Sin escandallo</div>}{r.recipe === 'missing_costs' && <div className="small" style={{ color: 'var(--warn)' }}>Faltan costes</div>}</td>
            <td className="right">{r.sold}</td><td className="right">{money(r.net_cents)}</td>
            <td className="right">{r.costCents != null ? money(r.costCents) : '—'}</td>
            <td className="right">{r.marginCents != null ? <>{money(r.marginCents)} <span className="small muted">({r.marginPct} %)</span></> : '—'}</td></tr>
        ))}</tbody>
      </table>
      <p className="small muted">El margen se calcula con el precio de venta y el escandallo: no incluye personal, alquiler ni suministros, así que no es el beneficio neto del negocio.</p>
    </div>
  );
}
