import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';
import { PAY_METHOD, TICKET_CATEGORY, TICKET_PRIORITY, TICKET_STATUS, TicketThread } from './Plataforma';

const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('es-ES');
const FEATURE_LABEL: Record<string, string> = { tpv: 'TPV', pda: 'PDA camareros', kitchen: 'Cocina', bar: 'Barra', menu: 'Carta QR', tables: 'Mesas', cash: 'Caja' };

/** El administrador del local ve su plan, sus facturas de Loryand y sus incidencias de soporte. */
export default function Suscripcion() {
  const [s, setS] = useState<any>(null);
  const [tickets, setTickets] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    api('/api/subscription').then(setS).catch(() => {});
    api<any[]>('/api/support/tickets').then(setTickets).catch(() => {});
  }, []);
  useEffect(load, [load]);
  if (!s) return <p className="muted">Cargando…</p>;
  const pending = s.invoices.filter((i: any) => i.status === 'issued' && i.kind === 'invoice');
  return (
    <div className="stack">
      <h1>Suscripción y soporte</h1>
      <div className="grid cols-2">
        <div className="card">
          <h3>Tu plan</h3>
          {s.contract ? <>
            <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>{s.contract.plan_name}</div>
            <p>{money(s.contract.monthly_cents)} al mes + IVA ({String(s.contract.vat_rate).replace('.', ',')} %) · {PAY_METHOD[s.contract.payment_method]}</p>
          </> : <p className="muted">Todavía no hay un contrato registrado.</p>}
          <div className="row" style={{ gap: '.3rem' }}>{s.features.map((f: string) => <span key={f} className="badge">{FEATURE_LABEL[f] ?? f}</span>)}</div>
        </div>
        <div className="card">
          <h3>Pagos</h3>
          {pending.length ? <p><strong>{money(pending.reduce((x: number, i: any) => x + i.total_cents, 0))}</strong> pendiente en {pending.length} factura{pending.length > 1 ? 's' : ''}.</p> : <p>No tienes facturas pendientes.</p>}
          {s.payTo.iban && <p className="small">Transferencia a {s.payTo.name}: <code>{s.payTo.iban.replace(/(.{4})/g, '$1 ').trim()}</code>, indicando el número de factura.</p>}
        </div>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <h3>Facturas de Loryand</h3>
        {s.invoices.length === 0 ? <p className="muted">Aún no hay facturas.</p> : (
          <table className="list">
            <thead><tr><th>Número</th><th>Fecha</th><th>Concepto</th><th className="right">Total</th><th>Estado</th><th></th></tr></thead>
            <tbody>{s.invoices.map((i: any) => (
              <tr key={i.id}>
                <td><code>{i.code}</code></td><td className="small">{fmtDate(i.issue_date)}</td>
                <td className="small">{i.lines[0]?.description}</td><td className="right">{money(i.total_cents)}</td>
                <td>{i.kind === 'rectifying' ? 'Rectificativa' : i.status === 'paid' ? <span className="badge">Pagada</span> : i.status === 'rectified' ? 'Rectificada' : i.overdue ? <span className="badge danger">Vencida</span> : <span className="badge warn">Vence {fmtDate(i.due_date)}</span>}</td>
                <td className="right"><Link className="btn small" to={`/gestion/factura/${i.id}`}>Ver o descargar</Link></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="spread"><h3 style={{ margin: 0 }}>Incidencias y consultas</h3><button className="btn primary" onClick={() => setCreating(true)}>+ Avisar a Loryand</button></div>
        {tickets.length === 0 ? <p className="muted mt">No has abierto ninguna incidencia.</p> : (
          <table className="list mt">
            <tbody>{tickets.map((t) => (
              <tr key={t.id} onClick={() => setOpen(t.id)} style={{ cursor: 'pointer' }}>
                <td>#{t.number}</td>
                <td>{t.unread_client && <span className="badge terra" style={{ marginRight: '.35rem' }}>Respuesta nueva</span>}<strong>{t.title}</strong><div className="small muted">{TICKET_CATEGORY[t.category]}</div></td>
                <td>{TICKET_STATUS[t.status]}</td>
                <td className="small">{new Date(t.updated_at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {open && <TicketThread id={open} side="client" onClose={() => { setOpen(null); load(); }} />}
      {creating && <NewTicket onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function NewTicket({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ title: '', body: '', category: 'question', priority: 'normal' });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const save = () => run(async () => { await api('/api/support/tickets', { body: f }); toast('Aviso enviado a Loryand'); onDone(); });
  return (
    <Modal title="Avisar a Loryand" onClose={onClose}>
      <label>Asunto<input autoFocus value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Por ejemplo: no imprime la cocina" /></label>
      <div className="grid cols-2">
        <label>Tipo<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(TICKET_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Urgencia<select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(TICKET_PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <label>¿Qué pasa? Cuanto más detalle (pantalla, hora, qué hacías), antes lo resolvemos<textarea rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || f.title.trim().length < 3 || f.body.trim().length < 3} onClick={save}>Enviar</button>
    </Modal>
  );
}
