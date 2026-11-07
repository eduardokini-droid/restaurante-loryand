import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { PHYSICAL_LABEL, ZONE_LABEL, money, minutesSince } from '../lib/format';
import { useLive } from '../lib/realtime';
import { ErrorText, useAction } from './ui';

export interface FloorTable {
  id: string; label: string; zone: string; seats: number; physical_state: string; access_open: boolean;
  account_id: string | null; opened_at: string | null; total_cents: number; paid_cents: number;
  undelivered: number; ready: number; held: number; requests: string[];
}
export interface BarAccount { account_id: string; bar_name: string; waiter_name: string | null; total_cents: number; paid_cents: number; opened_at: string }
export interface FloorData { sharedTables: boolean; tables: FloorTable[]; bar: BarAccount[] }

export function useFloor() {
  const [floor, setFloor] = useState<FloorData | null>(null);
  const load = useCallback(() => { api<FloorData>('/api/service/floor').then(setFloor).catch(() => {}); }, []);
  useEffect(load, [load]);
  const connected = useLive(load, ['orders', 'tables', 'payments', 'requests', 'waiters']);
  return { floor, reload: load, connected };
}

const REQ_LABEL: Record<string, string> = { pay: 'Quiere pagar', waiter: 'Llama al camarero', other: 'Otra atención' };

export function FloorGrid({ tables, onPick }: { tables: FloorTable[]; onPick: (t: FloorTable) => void }) {
  const zones = [...new Set(tables.map((t) => t.zone))];
  if (!tables.length) return <p className="muted">No hay mesas activas. Créalas en Gestión → Mesas.</p>;
  return (
    <div className="stack">
      {zones.map((z) => (
        <div key={z}>
          <h3>{ZONE_LABEL[z] ?? z}</h3>
          <div className="grid tiles">
            {tables.filter((t) => t.zone === z).map((t) => {
              const pending = t.total_cents - t.paid_cents;
              return (
                <button key={t.id} className={`table-tile ${t.physical_state} ${t.requests.length || t.ready ? 'alert' : ''}`} onClick={() => onPick(t)}>
                  <span className="spread"><span className="label">{t.label}</span><span className="small muted">{t.seats} pl.</span></span>
                  <span className="small">{PHYSICAL_LABEL[t.physical_state]}</span>
                  {t.account_id && pending > 0 && <span className="small"><strong>{money(pending)}</strong>{t.opened_at && <span className="muted"> · {minutesSince(t.opened_at)} min</span>}</span>}
                  <span className="row" style={{ gap: '.25rem' }}>
                    {t.ready > 0 && <span className="badge terra">{t.ready} listo(s)</span>}
                    {t.held > 0 && <span className="badge grey">pase en espera</span>}
                    {t.requests.map((r) => <span key={r} className="badge danger">{REQ_LABEL[r]}</span>)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Acciones sobre el estado físico y la clave de acceso de la mesa (capítulos 9 y 20). */
export function TableControls({ table, onChanged }: { table: FloorTable; onChanged: () => void }) {
  const [code, setCode] = useState<{ access_code: string; access_open: boolean } | null>(null);
  const { busy, error, run } = useAction();
  const state = (s: string) => run(async () => { await api(`/api/service/tables/${table.id}/state`, { body: { state: s } }); onChanged(); });
  const access = (action: string) => run(async () => setCode(await api(`/api/service/tables/${table.id}/access`, { body: { action } })));
  const attend = () => run(async () => {
    const reqs = await api<{ id: string; table_id: string }[]>('/api/service/requests');
    await Promise.all(reqs.filter((r) => r.table_id === table.id).map((r) => api(`/api/service/requests/${r.id}/attend`, { body: {} })));
    onChanged();
  });
  return (
    <div className="card stack">
      <div className="spread"><strong>Estado de la mesa</strong><span className="badge">{PHYSICAL_LABEL[table.physical_state]}</span></div>
      <div className="row">
        {table.physical_state === 'free' && <button className="btn small" disabled={busy} onClick={() => state('occupied')}>Sentar grupo</button>}
        {(table.physical_state === 'paid_occupied' || table.physical_state === 'occupied') && <button className="btn small" disabled={busy} onClick={() => state('dirty')}>Se han levantado</button>}
        {table.physical_state === 'dirty' && <button className="btn small primary" disabled={busy} onClick={() => state('free')}>Limpia · lista para sentar</button>}
        {table.requests.length > 0 && <button className="btn small terra" disabled={busy} onClick={attend}>Aviso atendido</button>}
      </div>
      <div className="spread">
        <span className="small">Clave de la carta: {code ? <strong style={{ letterSpacing: '.2em' }}>{code.access_open ? code.access_code : 'cerrada'}</strong> : '••••'}</span>
        <span className="row" style={{ gap: '.35rem' }}>
          <button className="btn small" disabled={busy} onClick={() => access('view')}>Ver clave</button>
          <button className="btn small" disabled={busy} onClick={() => access('regenerate')}>Cambiar</button>
          {(code?.access_open ?? table.access_open)
            ? <button className="btn small danger" disabled={busy} onClick={() => access('close')}>Cerrar acceso</button>
            : <button className="btn small" disabled={busy} onClick={() => access('open')}>Abrir acceso</button>}
        </span>
      </div>
      <ErrorText error={error} />
    </div>
  );
}
