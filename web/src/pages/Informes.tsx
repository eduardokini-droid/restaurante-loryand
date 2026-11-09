import { useCallback, useEffect, useState } from 'react';
import { api, getSelectedEstablishment } from '../lib/api';
import { METHOD_LABEL, money } from '../lib/format';
import { ErrorText, useAction } from '../components/ui';

const TZ = 'Europe/Madrid';
const iso = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: TZ });

/** Informes de ventas por producto, categoría, día, hora y camarero, exportables a Excel. */
export default function Informes() {
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));
  const [r, setR] = useState<any>(null);
  const [q, setQ] = useState('');
  const { error, run } = useAction();
  const load = useCallback(() => run(async () => setR(await api(`/api/reports/sales?from=${from}&to=${to}`))), [from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const preset = (k: 'today' | 'week' | 'month' | 'prev') => {
    const d = new Date();
    if (k === 'today') { setFrom(iso(d)); setTo(iso(d)); }
    if (k === 'week') { const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7)); setFrom(iso(s)); setTo(iso(d)); }
    if (k === 'month') { setFrom(iso(new Date(d.getFullYear(), d.getMonth(), 1))); setTo(iso(d)); }
    if (k === 'prev') { setFrom(iso(new Date(d.getFullYear(), d.getMonth() - 1, 1))); setTo(iso(new Date(d.getFullYear(), d.getMonth(), 0))); }
  };
  const exportCsv = async () => {
    const res = await fetch(`/api/reports/sales.csv?from=${from}&to=${to}`, { headers: { 'x-establishment-id': getSelectedEstablishment() ?? '' } });
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `ventas-${from}_${to}.csv`; a.click();
  };
  const products = (r?.byProduct ?? []).filter((p: any) => p.name.toLowerCase().includes(q.toLowerCase()) || p.category.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="stack">
      <div className="spread"><h1>Informes de ventas</h1><button className="btn primary" onClick={exportCsv}>Exportar a Excel</button></div>
      <div className="card row">
        <label style={{ margin: 0 }}>Desde<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ margin: 0 }}>Hasta<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn small" onClick={() => preset('today')}>Hoy</button>
        <button className="btn small" onClick={() => preset('week')}>Esta semana</button>
        <button className="btn small" onClick={() => preset('month')}>Este mes</button>
        <button className="btn small" onClick={() => preset('prev')}>Mes anterior</button>
      </div>
      <p className="small muted">Se cuentan las cuentas cobradas en el periodo, para que cuadre con la caja. Importes con IVA, salvo la columna «Base».</p>
      <ErrorText error={error} />
      {r && (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <Tile label="Total cobrado" value={money(r.kpi.total_cents)} />
            <Tile label="Tickets" value={String(r.kpi.tickets)} />
            <Tile label="Ticket medio" value={money(r.kpi.averageTicketCents)} />
            <Tile label="Descuentos y cupones" value={money(r.kpi.discounts_cents)} />
          </div>
          <div className="grid cols-2">
            <div className="card">
              <h3>Ventas por hora</h3>
              <HourBars rows={r.byHour} />
            </div>
            <div className="card">
              <h3>Por forma de pago</h3>
              <table className="list"><tbody>{r.byMethod.map((m: any) => <tr key={m.method}><td>{METHOD_LABEL[m.method]}</td><td className="right">{m.count}</td><td className="right">{money(m.cents)}</td></tr>)}</tbody></table>
              <h3 className="mt">Por camarero</h3>
              <table className="list">
                <thead><tr><th>Camarero</th><th className="right">Comandado</th><th className="right">Cobrado</th></tr></thead>
                <tbody>{r.byWaiter.map((w: any) => <tr key={w.name}><td>{w.name}</td><td className="right">{money(w.taken_cents)}</td><td className="right">{money(w.collected_cents)} <span className="small muted">({w.payments})</span></td></tr>)}</tbody>
              </table>
            </div>
          </div>
          <div className="card" style={{ overflowX: 'auto' }}>
            <div className="spread"><h3 style={{ margin: 0 }}>Por producto</h3><input style={{ maxWidth: 240 }} placeholder="Filtrar producto o categoría" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <table className="list mt">
              <thead><tr><th>Producto</th><th>Categoría</th><th className="right">Unidades</th><th className="right">Importe</th><th className="right">Base</th><th className="right">% ventas</th></tr></thead>
              <tbody>{products.map((p: any) => (
                <tr key={`${p.name}-${p.category}`}><td>{p.name}</td><td className="small muted">{p.category}</td><td className="right">{p.qty}</td><td className="right">{money(p.gross_cents)}</td><td className="right small muted">{money(p.net_cents)}</td>
                  <td className="right small">{r.kpi.total_cents ? `${((p.gross_cents / r.byProduct.reduce((s: number, x: any) => s + x.gross_cents, 0)) * 100).toFixed(1).replace('.', ',')} %` : '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="grid cols-2">
            <div className="card">
              <h3>Por categoría</h3>
              <table className="list"><tbody>{r.byCategory.map((c: any) => <tr key={c.category}><td>{c.category}</td><td className="right">{c.qty} ud.</td><td className="right">{money(c.gross_cents)}</td></tr>)}</tbody></table>
            </div>
            <div className="card">
              <h3>Por día</h3>
              <table className="list"><tbody>{r.byDay.map((d: any) => <tr key={d.day}><td>{new Date(`${d.day}T12:00:00`).toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' })}</td><td className="right">{d.tickets} tickets</td><td className="right">{money(d.cents)}</td></tr>)}</tbody></table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const Tile = ({ label, value }: { label: string; value: string }) => (
  <div className="card"><div className="small muted">{label}</div><div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{value}</div></div>
);

/** Barras por hora: una sola serie, barras finas con la punta redondeada sobre la línea base, detalle al pasar el puntero. */
function HourBars({ rows }: { rows: { hour: number; tickets: number; cents: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length) return <p className="muted">Sin ventas en el periodo.</p>;
  const first = Math.min(...rows.map((r) => r.hour)); const last = Math.max(...rows.map((r) => r.hour));
  const hours = Array.from({ length: last - first + 1 }, (_, k) => first + k);
  const max = Math.max(...rows.map((r) => r.cents));
  const h = hover != null ? rows.find((r) => r.hour === hover) : null;
  return (
    <div>
      <div style={{ height: 22 }} className="small">{h ? <><strong>{String(h.hour).padStart(2, '0')}:00–{String(h.hour + 1).padStart(2, '0')}:00</strong> · {money(h.cents)} · {h.tickets} tickets</> : <span className="muted">Pasa el dedo o el ratón por una barra</span>}</div>
      <div role="img" aria-label="Ventas por hora" style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 160, borderBottom: '1px solid var(--line)' }}>
        {hours.map((hr) => {
          const row = rows.find((r) => r.hour === hr);
          const pct = row ? Math.max(2, (row.cents / max) * 100) : 0;
          return (
            <div key={hr} onMouseEnter={() => setHover(hr)} onMouseLeave={() => setHover(null)} onTouchStart={() => setHover(hr)}
              title={row ? `${hr}:00 · ${money(row.cents)}` : `${hr}:00 · sin ventas`}
              style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', cursor: 'default' }}>
              {row && <div style={{ width: '70%', maxWidth: 28, height: `${pct}%`, background: 'var(--green)', opacity: hover == null || hover === hr ? 1 : 0.45, borderRadius: '4px 4px 0 0' }} />}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 2 }} className="small muted">
        {hours.map((hr) => <div key={hr} style={{ flex: 1, textAlign: 'center' }}>{(hr - first) % 2 === 0 ? hr : ''}</div>)}
      </div>
    </div>
  );
}
