import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { PHYSICAL_LABEL, ZONE_LABEL, minutesSince } from '../lib/format';
import { useLive } from '../lib/realtime';
import { ErrorText, Modal, useAction, useToast } from './ui';

interface Unit { key: string; tableIds: string[]; labels: string[]; seats: number; zone: string; state: string; blockedReason?: string }
interface Group {
  id: string; name: string; party_size: number; phone: string; zone_pref: string | null; status: string; created_at: string; notified_at: string | null;
  table_ids: string[]; table_labels: string[]; proposal: { tableIds: string[]; labels: string[]; seats: number } | null; estimateMin: number | null;
}

const unitName = (labels: string[]) => (labels.length > 1 ? `Mesas ${labels.join('+')}` : `Mesa ${labels[0]}`);

/** Lista de espera presencial (capítulo 20). */
export function Waitlist() {
  const [data, setData] = useState<{ groups: Group[]; units: Unit[]; averageStayMin: number; averageFromSamples: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [choosing, setChoosing] = useState<Group | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => { api('/api/waitlist').then(setData).catch(() => {}); }, []);
  useEffect(load, [load]);
  useLive(load, ['tables', 'payments', 'orders'], { intervalMs: 30000 });

  const act = (g: Group, path: string, body: object = {}, msg?: string) => run(async () => { await api(`/api/waitlist/${g.id}/${path}`, { body }); if (msg) toast(msg); load(); });
  if (!data) return <p className="muted">Cargando lista de espera…</p>;
  const waiting = data.groups.filter((g) => g.status === 'waiting');
  const notified = data.groups.filter((g) => g.status === 'notified');
  const free = data.units.filter((u) => u.state === 'free');

  return (
    <div className="stack">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Lista de espera</h2>
        <button className="btn terra" onClick={() => setAdding(true)}>+ Añadir grupo</button>
      </div>
      <div className="row small muted">
        <span>Libres y limpias: <strong>{free.map((u) => unitName(u.labels)).join(', ') || 'ninguna'}</strong></span>
        <span>· Estancia media: {data.averageStayMin} min{data.averageFromSamples < 5 && ' (valor inicial, se ajustará con el uso)'}</span>
      </div>
      <ErrorText error={error} />

      {notified.length > 0 && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>Avisados · mesa reservada para ellos</h3>
          {notified.map((g) => (
            <div key={g.id} className="spread">
              <span><strong>{g.name}</strong> · {g.party_size} pers. · {unitName(g.table_labels)} <span className="muted small">· avisados hace {minutesSince(g.notified_at!)} min</span></span>
              <span className="row" style={{ gap: '.3rem' }}>
                <button className="btn small primary" disabled={busy} onClick={() => act(g, 'seat', {}, `${g.name} sentados`)}>Ya están sentados</button>
                <button className="btn small" disabled={busy} onClick={() => act(g, 'close', { reason: 'release' }, 'Vuelve a la cola con su antigüedad')}>Liberar mesa</button>
                <button className="btn small ghost" disabled={busy} onClick={() => confirm('¿Marcar como no presentado?') && act(g, 'close', { reason: 'no_show' })}>No presentado</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        {waiting.length === 0 && <p className="muted" style={{ margin: 0 }}>No hay grupos esperando.</p>}
        {waiting.map((g, i) => (
          <div key={g.id} className="spread" style={{ padding: '.6rem 0', borderBottom: i < waiting.length - 1 ? '1px solid var(--line)' : undefined }}>
            <div>
              <strong>{i + 1}. {g.name}</strong> · {g.party_size} pers.{g.zone_pref && <> · prefiere {ZONE_LABEL[g.zone_pref]}</>}
              <div className="small muted">Esperando {minutesSince(g.created_at)} min{g.phone && ` · ${g.phone}`}</div>
              <div className="small">
                {g.proposal
                  ? <span className="badge">Propuesta: {unitName(g.proposal.labels)} ({g.proposal.seats} pl.)</span>
                  : g.estimateMin != null
                    ? <span className="badge warn">Espera estimada ≈ {g.estimateMin} min</span>
                    : <span className="badge grey">Sin mesa compatible ahora</span>}
              </div>
            </div>
            <span className="row" style={{ gap: '.3rem' }}>
              {g.proposal && <button className="btn small primary" disabled={busy} onClick={() => act(g, 'assign', { tableIds: g.proposal!.tableIds }, `Mesa asignada. Avisa a ${g.name}: el programa no envía mensajes.`)}>Confirmar {unitName(g.proposal.labels)} y marcar avisado</button>}
              <button className="btn small" onClick={() => setChoosing(g)}>Otra mesa…</button>
              <button className="btn small ghost" disabled={busy} onClick={() => confirm(`¿Cancelar la espera de ${g.name}?`) && act(g, 'close', { reason: 'cancelled' })}>Cancelar</button>
            </span>
          </div>
        ))}
      </div>
      <p className="small muted">La espera estimada se calcula con la duración media real de las mesas del local y su estado actual (pagada, pendiente de limpiar…). Es orientativa: la disponibilidad la confirma el personal.</p>

      {adding && <AddGroup onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {choosing && (
        <Modal title={`Mesa para ${choosing.name} (${choosing.party_size})`} onClose={() => setChoosing(null)}>
          <div className="grid tiles">
            {data.units.map((u) => {
              const ok = u.state === 'free' && u.seats >= choosing.party_size;
              return (
                <button key={u.key} className={`table-tile ${u.state === 'free' ? '' : u.state}`} disabled={!ok || busy} style={{ opacity: ok ? 1 : .5 }}
                  onClick={() => { act(choosing, 'assign', { tableIds: u.tableIds }, `Mesa asignada. Avisa a ${choosing.name}.`); setChoosing(null); }}>
                  <span className="label">{u.labels.join('+')}</span>
                  <span className="small">{u.seats} pl. · {ZONE_LABEL[u.zone]}</span>
                  <span className="small muted">{u.blockedReason ?? (u.state === 'free' ? 'Libre' : PHYSICAL_LABEL[u.state])}</span>
                </button>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}

function AddGroup({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', partySize: 2, phone: '', zonePref: '' });
  const { busy, error, run } = useAction();
  const save = () => run(async () => { await api('/api/waitlist', { body: { ...f, zonePref: f.zonePref || null } }); onDone(); });
  return (
    <Modal title="Añadir a la lista de espera" onClose={onClose}>
      <label>Nombre<input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Comensales<input type="number" min={1} value={f.partySize} onChange={(e) => setF({ ...f, partySize: Number(e.target.value) })} /></label>
      <label>Teléfono (opcional)<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label>Zona preferida<select value={f.zonePref} onChange={(e) => setF({ ...f, zonePref: e.target.value })}>
        <option value="">Cualquiera</option>{Object.entries(ZONE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !f.name.trim() || f.partySize < 1} onClick={save}>Añadir</button>
    </Modal>
  );
}
