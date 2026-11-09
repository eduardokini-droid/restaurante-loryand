import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getSelectedEstablishment } from '../lib/api';
import { useSession } from '../lib/session';
import { useLive } from '../lib/realtime';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';

const TZ = 'Europe/Madrid';
const ROLE: Record<string, string> = { sala: 'Sala', cocina: 'Cocina', barra: 'Barra', otros: 'Otros' };
const hm = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
const clock = (d: string | null) => (d ? new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—');
const dayLabel = (d: string) => new Date(d).toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TZ });
const iso = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
/** Valor para <input type="datetime-local"> en hora local. */
const toLocalInput = (d: string | null) => {
  if (!d) return '';
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/** Registro de jornada (art. 34.9 ET): consulta, correcciones trazables, exportación y hoja mensual. */
export default function Jornada() {
  const { me } = useSession();
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));
  const [waiterId, setWaiterId] = useState('');
  const [staff, setStaff] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [edit, setEdit] = useState<any | null>(null);
  const [history, setHistory] = useState<any[] | null>(null);
  const [sheet, setSheet] = useState(false);
  const { error, run } = useAction();
  const load = useCallback(() => {
    api(`/api/staff/shifts?from=${from}&to=${to}${waiterId ? `&waiterId=${waiterId}` : ''}`).then(setRows).catch(() => {});
  }, [from, to, waiterId]);
  useEffect(load, [load]);
  useEffect(() => { api('/api/admin/waiters').then(setStaff).catch(() => {}); }, []);
  useLive(load, ['waiters'], { intervalMs: 60000 });

  const pending = rows.filter((r) => r.needs_review);
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.status !== 'voided') m.set(r.name, (m.get(r.name) ?? 0) + r.worked_min);
    return [...m.entries()];
  }, [rows]);
  const exportCsv = async () => {
    const res = await fetch(`/api/staff/timesheet.csv?from=${from}&to=${to}${waiterId ? `&waiterId=${waiterId}` : ''}`, { headers: { 'x-establishment-id': getSelectedEstablishment() ?? '' } });
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `registro-jornada-${from}_${to}.csv`; a.click();
  };
  const preset = (k: 'month' | 'prev') => {
    const d = new Date();
    if (k === 'month') { setFrom(iso(new Date(d.getFullYear(), d.getMonth(), 1))); setTo(iso(d)); }
    else { setFrom(iso(new Date(d.getFullYear(), d.getMonth() - 1, 1))); setTo(iso(new Date(d.getFullYear(), d.getMonth(), 0))); }
  };

  return (
    <div className="stack">
      <div className="spread"><h1>Registro de jornada</h1>
        <span className="row">
          <button className="btn" onClick={() => setEdit({ waiterId: waiterId || staff[0]?.id, startedAt: '', endedAt: '', reason: '' })}>+ Añadir fichaje olvidado</button>
          <button className="btn" onClick={exportCsv}>Exportar a Excel</button>
          <button className="btn primary" disabled={!waiterId} title={waiterId ? '' : 'Elige un trabajador'} onClick={() => setSheet(true)}>Hoja mensual para firmar</button>
        </span>
      </div>
      <p className="small muted">Entrada y salida de cada trabajador, con pausas. Las correcciones quedan registradas con quién, cuándo, el valor anterior y el motivo; los fichajes no se borran, se anulan. Conserva los registros 4 años (las copias de seguridad los incluyen).</p>
      <div className="card row">
        <label style={{ margin: 0 }}>Desde<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ margin: 0 }}>Hasta<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label style={{ margin: 0 }}>Trabajador<select value={waiterId} onChange={(e) => setWaiterId(e.target.value)}>
          <option value="">Todos</option>{staff.map((w) => <option key={w.id} value={w.id}>{w.name} · {ROLE[w.staff_role]}</option>)}</select></label>
        <button className="btn small" onClick={() => preset('month')}>Este mes</button>
        <button className="btn small" onClick={() => preset('prev')}>Mes anterior</button>
      </div>
      {pending.length > 0 && <div className="notice"><strong>{pending.length} fichaje(s) pendientes de revisar</strong>: salidas no fichadas que el programa cerró con la última actividad registrada. Revisa la hora real y corrígela o confírmala.</div>}
      <ErrorText error={error} />
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="list">
          <thead><tr><th>Día</th><th>Trabajador</th><th>Entrada</th><th>Salida</th><th>Pausas</th><th className="right">Trabajado</th><th>Estado</th><th></th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} style={r.status === 'voided' ? { opacity: .5, textDecoration: 'line-through' } : r.needs_review ? { background: 'var(--terra-soft)' } : undefined}>
              <td>{dayLabel(r.started_at)}</td>
              <td><strong>{r.name}</strong><div className="small muted">{ROLE[r.staff_role]}{r.document_id && ` · ${r.document_id}`}</div></td>
              <td>{clock(r.started_at)}</td>
              <td>{r.ended_at ? clock(r.ended_at) : <span className="badge">En curso</span>}</td>
              <td className="small">{r.break_min ? `${r.break_min} min` : '—'}</td>
              <td className="right">{hm(r.worked_min)}</td>
              <td>{r.status === 'voided' ? <span className="badge grey">Anulado</span> : r.needs_review ? <span className="badge danger">Revisar</span> : r.corrections ? <span className="badge warn">Corregido</span> : <span className="badge">Correcto</span>}
                {r.origin === 'manager' && <div className="small muted">alta manual</div>}</td>
              <td className="right"><div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                {r.status !== 'voided' && <button className="btn small" onClick={() => setEdit({ id: r.id, waiterId: r.waiter_id, name: r.name, startedAt: toLocalInput(r.started_at), endedAt: toLocalInput(r.ended_at), reason: r.needs_review ? '' : '', review: r.needs_review })}>{r.needs_review ? 'Revisar' : 'Corregir'}</button>}
                {(r.corrections > 0 || r.history) && <button className="btn small ghost" onClick={() => run(async () => setHistory(await api(`/api/staff/shifts/${r.id}/history`)))}>Historial</button>}
              </div></td>
            </tr>
          ))}</tbody>
        </table>
        {rows.length === 0 && <p className="muted">No hay fichajes en este periodo.</p>}
        {totals.length > 0 && <div className="mt small"><strong>Totales del periodo:</strong> {totals.map(([n, m]) => `${n}: ${hm(m)}`).join(' · ')}</div>}
      </div>
      {edit && <EditShift e={edit} staff={staff} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
      {history && (
        <Modal title="Historial de correcciones" onClose={() => setHistory(null)}>
          {history.map((h, i) => (
            <div key={i} className="card small" style={{ marginBottom: '.5rem' }}>
              <div className="spread"><strong>{({ create: 'Alta manual', update: 'Corrección', void: 'Anulación', auto_close: 'Cierre automático' } as any)[h.action]}</strong><span className="muted">{new Date(h.created_at).toLocaleString('es-ES', { timeZone: TZ })}</span></div>
              <div>Por: {h.actor}</div>
              {h.before && <div className="muted">Antes: {clock(h.before.startedAt)} → {clock(h.before.endedAt)}</div>}
              {h.after && <div>Después: {clock(h.after.startedAt)} → {clock(h.after.endedAt)}</div>}
              <div>Motivo: {h.reason}</div>
            </div>
          ))}
        </Modal>
      )}
      {sheet && <MonthlySheet rows={rows} worker={staff.find((w) => w.id === waiterId)} establishment={me?.establishment?.name ?? ''} from={from} to={to} onClose={() => setSheet(false)} />}
    </div>
  );
}

function EditShift({ e, staff, onClose, onDone }: { e: any; staff: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState(e);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const toIso = (v: string) => (v ? new Date(v).toISOString() : null);
  const save = () => run(async () => {
    if (f.id) await api(`/api/staff/shifts/${f.id}`, { method: 'PATCH', body: { startedAt: toIso(f.startedAt), endedAt: toIso(f.endedAt), reason: f.reason } });
    else await api('/api/staff/shifts', { body: { waiterId: f.waiterId, startedAt: toIso(f.startedAt), endedAt: toIso(f.endedAt), reason: f.reason } });
    toast('Fichaje guardado con su motivo'); onDone();
  });
  const voidIt = () => run(async () => {
    if (!f.reason || f.reason.trim().length < 5) throw new Error('Escribe el motivo de la anulación');
    if (!confirm('¿Anular este fichaje? No se borra: queda registrado como anulado con su motivo.')) return;
    await api(`/api/staff/shifts/${f.id}/void`, { body: { reason: f.reason } }); onDone();
  });
  return (
    <Modal title={f.id ? `${f.review ? 'Revisar' : 'Corregir'} fichaje · ${f.name}` : 'Añadir fichaje olvidado'} onClose={onClose}>
      {f.review && <p className="notice small">La salida no se fichó: el programa la cerró con la última actividad registrada. Pon la hora real o confírmala tal cual escribiendo el motivo.</p>}
      {!f.id && <label>Trabajador<select value={f.waiterId} onChange={(ev) => setF({ ...f, waiterId: ev.target.value })}>{staff.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
      <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label>Entrada<input type="datetime-local" value={f.startedAt} onChange={(ev) => setF({ ...f, startedAt: ev.target.value })} /></label>
        <label>Salida<input type="datetime-local" value={f.endedAt} onChange={(ev) => setF({ ...f, endedAt: ev.target.value })} /></label>
      </div>
      <label>Motivo (obligatorio, queda en el historial)<input value={f.reason} onChange={(ev) => setF({ ...f, reason: ev.target.value })} placeholder={f.review ? 'Confirmado con el trabajador: salió a las…' : 'Olvidó fichar; confirmado con el trabajador'} /></label>
      <ErrorText error={error} />
      <div className="spread">
        {f.id ? <button className="btn danger" disabled={busy} onClick={voidIt}>Anular fichaje</button> : <span />}
        <button className="btn primary" disabled={busy || !f.startedAt || (f.reason ?? '').trim().length < 5} onClick={save}>Guardar</button>
      </div>
    </Modal>
  );
}

/** Hoja mensual por trabajador para imprimir y firmar. */
function MonthlySheet({ rows, worker, establishment, from, to, onClose }: { rows: any[]; worker: any; establishment: string; from: string; to: string; onClose: () => void }) {
  const mine = rows.filter((r) => r.waiter_id === worker?.id && r.status !== 'voided');
  const total = mine.reduce((s, r) => s + r.worked_min, 0);
  return (
    <Modal title="Hoja de registro de jornada" onClose={onClose}>
      <div className="printable" style={{ background: '#fff', color: '#000', padding: 12, fontSize: 12 }}>
        <h2 style={{ color: '#000' }}>Registro diario de jornada</h2>
        <div>Empresa: <strong>{establishment}</strong></div>
        <div>Trabajador: <strong>{worker?.name}</strong>{worker?.document_id && ` · DNI/NIE ${worker.document_id}`} · Puesto: {ROLE[worker?.staff_role]}</div>
        <div>Periodo: {new Date(from).toLocaleDateString('es-ES')} a {new Date(to).toLocaleDateString('es-ES')}</div>
        <table className="list" style={{ marginTop: 8 }}>
          <thead><tr><th>Día</th><th>Entrada</th><th>Salida</th><th>Pausas</th><th className="right">Horas</th><th>Observaciones</th></tr></thead>
          <tbody>{mine.map((r) => (
            <tr key={r.id}><td>{dayLabel(r.started_at)}</td><td>{clock(r.started_at)}</td><td>{clock(r.ended_at)}</td><td>{r.break_min ? `${r.break_min} min` : ''}</td>
              <td className="right">{hm(r.worked_min)}</td><td className="small">{r.corrections ? 'Corregido (ver historial)' : r.needs_review ? 'Pendiente de revisar' : ''}</td></tr>
          ))}</tbody>
        </table>
        <p><strong>Total del periodo: {hm(total)}</strong></p>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 40 }}>
          <div>Firma de la empresa<br /><br />______________________</div>
          <div>Firma del trabajador<br /><br />______________________</div>
        </div>
      </div>
      <button className="btn primary block mt" onClick={() => window.print()}>Imprimir</button>
    </Modal>
  );
}
