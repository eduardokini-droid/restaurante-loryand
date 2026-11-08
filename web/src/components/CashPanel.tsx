import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { METHOD_LABEL, dateTime, money, time, toCents } from '../lib/format';
import { useLive } from '../lib/realtime';
import { useSession } from '../lib/session';
import { ErrorText, Modal, useAction, useToast } from './ui';

const DENOMS: [string, number][] = [
  ['500', 50000], ['200', 20000], ['100', 10000], ['50', 5000], ['20', 2000], ['10', 1000], ['5', 500],
  ['2', 200], ['1', 100], ['0.50', 50], ['0.20', 20], ['0.10', 10], ['0.05', 5], ['0.02', 2], ['0.01', 1],
];

/** Caja del día: apertura con fondo, entradas/salidas, cajón y cierre con arqueo ciego. */
export function CashPanel({ compact = false }: { compact?: boolean }) {
  const { me } = useSession();
  const canClose = !!me?.modules.includes('cash');
  const [d, setD] = useState<{ session: any; summary: any } | null>(null);
  const [float, setFloat] = useState('150');
  const [move, setMove] = useState<{ kind: 'in' | 'out'; amount: string; reason: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => { api('/api/cash/current').then(setD).catch(() => {}); }, []);
  useEffect(load, [load]);
  useLive(load, ['payments']);
  if (!d) return null;

  const drawer = () => run(async () => { await api('/api/cash/drawer', { body: {} }); toast('Abriendo cajón'); });

  if (!d.session) {
    return (
      <div className="card">
        <div className="spread"><h3 style={{ margin: 0 }}>Caja cerrada</h3><span className="badge warn">Sin abrir</span></div>
        <p className="small muted">Abre la caja con el efectivo que dejas de cambio. Los cobros que se hagan con la caja cerrada pasarán a la próxima caja que se abra.</p>
        <div className="row">
          <label style={{ margin: 0 }}>Fondo de caja (€)<input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} style={{ width: 120 }} /></label>
          <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api('/api/cash/open', { body: { floatCents: toCents(float || '0') } }); toast('Caja abierta'); load(); })}>Abrir caja</button>
        </div>
        <ErrorText error={error} />
        {result && <ZResult z={result} onClose={() => setResult(null)} />}
      </div>
    );
  }

  const s = d.summary;
  return (
    <div className="card stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Caja abierta</h3>
        <span className="small muted">desde {time(d.session.opened_at)} · {d.session.opened_by}</span>
      </div>
      <div className="grid cols-2" style={{ gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div><div className="small muted">Fondo inicial</div><strong>{money(s.openingFloatCents)}</strong></div>
        {(['cash', 'card', 'bizum'] as const).map((m) => <div key={m}><div className="small muted">{METHOD_LABEL[m]} ({s.byMethod[m].count})</div><strong>{money(s.byMethod[m].cents)}</strong></div>)}
      </div>
      {s.movements.length > 0 && (
        <div className="small">{s.movements.map((m: any, i: number) => (
          <div key={i} className="spread"><span>{time(m.createdAt)} · {m.reason} <span className="muted">({m.actor})</span></span><span style={{ color: m.kind === 'out' ? 'var(--terra)' : 'var(--ok)' }}>{m.kind === 'out' ? '−' : '+'}{money(m.amountCents)}</span></div>
        ))}</div>
      )}
      {s.onlineConflicts > 0 && <p className="notice small">Hay {s.onlineConflicts} cobro(s) online por revisar.</p>}
      <div className="row">
        <button className="btn small" onClick={() => setMove({ kind: 'out', amount: '', reason: '' })}>Salida de efectivo</button>
        <button className="btn small" onClick={() => setMove({ kind: 'in', amount: '', reason: '' })}>Entrada de efectivo</button>
        <button className="btn small" disabled={busy} onClick={drawer}>Abrir cajón</button>
        {canClose && <button className="btn primary small" onClick={() => setClosing(true)}>Cerrar caja</button>}
      </div>
      <ErrorText error={error} />
      {move && (
        <Modal title={move.kind === 'out' ? 'Salida de efectivo' : 'Entrada de efectivo'} onClose={() => setMove(null)}>
          <p className="small muted">{move.kind === 'out' ? 'Dinero que sale de la caja sin ser una devolución de venta: pago a un proveedor, retirada al banco…' : 'Dinero que entra sin ser una venta: cambio traído del banco…'}</p>
          <label>Importe (€)<input autoFocus inputMode="decimal" value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} /></label>
          <label>Motivo<input value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} placeholder={move.kind === 'out' ? 'Pago al panadero' : 'Cambio del banco'} /></label>
          <ErrorText error={error} />
          <button className="btn primary block" disabled={busy || !move.amount || move.reason.trim().length < 3} onClick={() => run(async () => {
            await api('/api/cash/movements', { body: { kind: move.kind, amountCents: toCents(move.amount), reason: move.reason } }); setMove(null); load();
          })}>Registrar</button>
        </Modal>
      )}
      {closing && <CloseDialog onClose={() => setClosing(false)} onDone={(z) => { setClosing(false); setResult(z); load(); }} />}
      {result && <ZResult z={result} onClose={() => setResult(null)} />}
    </div>
  );
}

/** Arqueo ciego: se cuenta el efectivo sin ver antes cuánto debería haber. */
function CloseDialog({ onClose, onDone }: { onClose: () => void; onDone: (z: any) => void }) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [manual, setManual] = useState('');
  const [notes, setNotes] = useState('');
  const { busy, error, run } = useAction();
  const byDenoms = DENOMS.reduce((t, [k, v]) => t + (parseInt(counts[k] || '0', 10) || 0) * v, 0);
  const total = manual ? toCents(manual) : byDenoms;
  const detail = manual ? null : Object.fromEntries(DENOMS.filter(([k]) => parseInt(counts[k] || '0', 10) > 0).map(([k]) => [k, parseInt(counts[k], 10)]));
  return (
    <Modal title="Cerrar caja · recuento" onClose={onClose}>
      <p className="small muted">Cuenta el efectivo del cajón (incluido el fondo). Después verás lo que debería haber y el descuadre.</p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '.4rem' }}>
        {DENOMS.map(([k, v]) => (
          <label key={k} style={{ margin: 0 }}>{v >= 500 ? `Billetes de ${k} €` : `Monedas de ${k} €`}
            <input inputMode="numeric" value={counts[k] ?? ''} disabled={!!manual} onChange={(e) => setCounts({ ...counts, [k]: e.target.value.replace(/\D/g, '') })} placeholder="0" /></label>
        ))}
      </div>
      <label className="mt">O escribe el total contado (€)<input inputMode="decimal" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Opcional" /></label>
      <div className="spread"><strong>Total contado</strong><strong style={{ fontSize: '1.3rem' }}>{money(total)}</strong></div>
      <label>Notas (opcional)<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy} onClick={() => run(async () => {
        if (!confirm(`¿Cerrar la caja con ${money(total)} contados? El cierre no se puede deshacer.`)) return;
        onDone(await api('/api/cash/close', { body: { countedCashCents: total, detail, notes } }));
      })}>Cerrar caja</button>
    </Modal>
  );
}

export function ZResult({ z, onClose }: { z: any; onClose: () => void }) {
  const r = z.report;
  const { busy, error, run } = useAction();
  const toast = useToast();
  const diff = z.difference_cents as number;
  return (
    <Modal title={`Cierre Z ${z.number}`} onClose={onClose}>
      <div className="printable stack">
        <div className="small muted">{dateTime(r.openedAt)} → {dateTime(r.closedAt)} · cerrado por {r.closedBy}</div>
        <div className="card">
          <div className="spread"><span>Fondo inicial</span><span>{money(r.openingFloatCents)}</span></div>
          <div className="spread"><span>Cobros en efectivo</span><span>{money(r.byMethod.cash.cents)}</span></div>
          {r.movementsInCents > 0 && <div className="spread"><span>Entradas</span><span>+{money(r.movementsInCents)}</span></div>}
          {r.movementsOutCents > 0 && <div className="spread"><span>Salidas</span><span>−{money(r.movementsOutCents)}</span></div>}
          <div className="spread"><strong>Debería haber</strong><strong>{money(z.expected_cash_cents)}</strong></div>
          <div className="spread"><strong>Contado</strong><strong>{money(z.counted_cash_cents)}</strong></div>
          <div className="spread" style={{ fontSize: '1.2rem', color: diff === 0 ? 'var(--ok)' : 'var(--terra)' }}><strong>Descuadre</strong><strong>{diff > 0 ? '+' : ''}{money(diff)}</strong></div>
        </div>
        <div className="card small">
          {(['cash', 'card', 'bizum'] as const).map((m) => <div key={m} className="spread"><span>{METHOD_LABEL[m]} ({r.byMethod[m].count})</span><span>{money(r.byMethod[m].cents)}</span></div>)}
          <div className="spread"><strong>Total cobrado</strong><strong>{money(r.totalCents)}</strong></div>
          <div>Tickets: {r.documents.simplified}{r.documents.first && ` (${r.documents.first} a ${r.documents.last})`} · Facturas: {r.documents.full}</div>
          {r.vat.map((v: any) => <div key={v.rate} className="spread"><span>IVA {v.rate}% · base {money(v.baseCents)}</span><span>{money(v.vatCents)}</span></div>)}
          {r.discountsCents > 0 && <div className="spread"><span>Descuentos y cupones</span><span>{money(r.discountsCents)}</span></div>}
          <div>Productos anulados: {r.cancelledItems}</div>
        </div>
        {r.byWaiter.length > 0 && <div className="card small">{r.byWaiter.map((w: any) => <div key={w.name} className="spread"><span>{w.name} ({w.count})</span><span>{money(w.cents)}</span></div>)}</div>}
        {r.pendingAccounts.length > 0 && <div className="notice small"><strong>Cuentas abiertas al cerrar:</strong> {r.pendingAccounts.map((p: any) => `${p.place} (${money(p.pendingCents)})`).join(', ')}</div>}
        {r.notes && <div className="small">Notas: {r.notes}</div>}
      </div>
      <ErrorText error={error} />
      <div className="row mt">
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api(`/api/cash/sessions/${z.id}/print`, { body: {} }); toast('Enviado a la impresora de tickets'); })}>Imprimir en impresora de tickets</button>
        <button className="btn" onClick={() => window.print()}>Imprimir desde el navegador</button>
      </div>
    </Modal>
  );
}

/** Historial de cierres Z. */
export function CashHistory() {
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  useEffect(() => { api('/api/cash/sessions').then(setList).catch(() => {}); }, []);
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <h3>Cierres de caja</h3>
      {list.length === 0 ? <p className="muted">Todavía no hay cierres.</p> : (
        <table className="list"><thead><tr><th>Z</th><th>Apertura → cierre</th><th className="right">Cobrado</th><th className="right">Efectivo esperado</th><th className="right">Contado</th><th className="right">Descuadre</th></tr></thead>
          <tbody>{list.map((s) => (
            <tr key={s.id} onClick={() => api(`/api/cash/sessions/${s.id}`).then(setOpen)} style={{ cursor: 'pointer' }}>
              <td><strong>{s.number}</strong></td><td className="small">{dateTime(s.opened_at)} → {dateTime(s.closed_at)}<div className="muted">{s.closed_by}</div></td>
              <td className="right">{money(s.total_cents)}</td><td className="right">{money(s.expected_cash_cents)}</td><td className="right">{money(s.counted_cash_cents)}</td>
              <td className="right" style={{ color: s.difference_cents === 0 ? 'var(--ok)' : 'var(--terra)' }}>{s.difference_cents > 0 ? '+' : ''}{money(s.difference_cents)}</td>
            </tr>
          ))}</tbody></table>
      )}
      {open && <ZResult z={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
