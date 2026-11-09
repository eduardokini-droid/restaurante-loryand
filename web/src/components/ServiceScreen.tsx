import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, minutesSince } from '../lib/format';
import { AccountView } from './AccountView';
import { FloorGrid, TableControls, useFloor, type FloorTable } from './Floor';
import { OrderBuilder, type OrderTarget } from './OrderBuilder';
import { Empty } from './ui';
import { WaiterAccess } from './WaiterAccess';
import { CashPanel } from './CashPanel';
import { Modal } from './ui';

type View =
  | { kind: 'floor' }
  | { kind: 'table'; tableId: string; accountId: string | null; ordering: boolean }
  | { kind: 'bar'; accountId: string | null; barName: string; waiterId?: string; ordering: boolean };

/** Pantalla de servicio común al TPV y a la PDA: plano → mesa o cliente de barra → comanda / cuenta. */
export function ServiceScreen({ mode }: { mode: 'tpv' | 'pda' }) {
  const { floor, reload } = useFloor();
  const [view, setView] = useState<View>({ kind: 'floor' });
  const [newBar, setNewBar] = useState(false);
  const [access, setAccess] = useState(false);
  const [cash, setCash] = useState(false);

  if (!floor) return <p className="muted">Cargando sala…</p>;

  if (view.kind === 'table') {
    const t = floor.tables.find((x) => x.id === view.tableId);
    if (!t) return <Empty>La mesa ya no está disponible.</Empty>;
    const target: OrderTarget = t.account_id ? { accountId: t.account_id } : { tableId: t.id };
    return (
      <div className="stack">
        <button className="btn ghost small" onClick={() => setView({ kind: 'floor' })}>← Cambiar ubicación</button>
        {view.ordering || !view.accountId ? (
          <>
            <h2>Mesa {t.label} · nueva comanda</h2>
            <OrderBuilder target={target} targetLabel={`Mesa ${t.label}`}
              onSent={(accountId) => { reload(); setView({ ...view, accountId: accountId ?? view.accountId, ordering: !accountId && !view.accountId }); }} />
            {view.accountId && <button className="btn" onClick={() => setView({ ...view, ordering: false })}>Ver cuenta de la mesa</button>}
          </>
        ) : (
          // Se mantiene la cuenta mostrada aunque se cobre, para poder imprimir el ticket.
          <AccountView accountId={view.accountId} onAddMore={() => setView({ ...view, accountId: t.account_id, ordering: true })} onClosed={reload} onMoved={() => { reload(); setView({ kind: 'floor' }); }} />
        )}
        <TableControls table={t} onChanged={reload} />
      </div>
    );
  }

  if (view.kind === 'bar') {
    const label = `Barra · ${view.barName}`;
    return (
      <div className="stack">
        <button className="btn ghost small" onClick={() => setView({ kind: 'floor' })}>← Cambiar ubicación</button>
        {view.ordering || !view.accountId ? (
          <>
            <h2>{label} · nueva comanda</h2>
            <OrderBuilder
              target={view.accountId ? { accountId: view.accountId } : { barName: view.barName }}
              targetLabel={label}
              extraBody={view.waiterId ? { waiterId: view.waiterId } : undefined}
              onSent={(accountId) => { reload(); setView({ ...view, accountId: accountId ?? view.accountId, ordering: false }); }}
            />
          </>
        ) : (
          <AccountView accountId={view.accountId} onAddMore={() => setView({ ...view, ordering: true })} onClosed={reload} onMoved={() => { reload(); setView({ kind: 'floor' }); }} />
        )}
      </div>
    );
  }

  const openTable = (t: FloorTable) => setView({ kind: 'table', tableId: t.id, accountId: t.account_id, ordering: !t.account_id });

  return (
    <div className="stack">
      <div className="spread">
        <h2 style={{ margin: 0 }}>¿Dónde vas a atender?</h2>
        <span className="row">
          {mode === 'tpv' && <button className="btn" onClick={() => setCash(true)}>Caja</button>}
          {mode === 'tpv' && <button className="btn" onClick={() => setAccess(true)}>Acceso camareros</button>}
          <button className="btn terra" onClick={() => setNewBar(true)}>+ Cliente de barra</button>
        </span>
      </div>
      {mode === 'pda' && !floor.sharedTables && <p className="small muted">Modo exclusivo: solo ves las mesas asignadas a ti.</p>}
      {floor.bar.length > 0 && (
        <div>
          <h3>Cuentas en barra</h3>
          <div className="grid tiles">
            {floor.bar.map((b) => (
              <button key={b.account_id} className="table-tile occupied" onClick={() => setView({ kind: 'bar', accountId: b.account_id, barName: b.bar_name, ordering: false })}>
                <span className="label" style={{ fontSize: '1.05rem' }}>{b.bar_name}</span>
                <span className="small"><strong>{money(b.total_cents - b.paid_cents)}</strong> · {minutesSince(b.opened_at)} min</span>
                <span className="small muted">{b.waiter_name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <FloorGrid tables={floor.tables} onPick={openTable} />
      {access && <WaiterAccess onClose={() => setAccess(false)} />}
      {cash && <Modal title="Caja" onClose={() => setCash(false)}><CashPanel compact /></Modal>}
      {newBar && <NewBarDialog mode={mode} existing={floor.bar.map((b) => b.bar_name.toLowerCase())} onClose={() => setNewBar(false)}
        onStart={(barName, waiterId) => {
          setNewBar(false);
          const ex = floor.bar.find((b) => b.bar_name.toLowerCase() === barName.trim().toLowerCase());
          setView({ kind: 'bar', accountId: ex?.account_id ?? null, barName: barName.trim(), waiterId, ordering: true });
        }} />}
    </div>
  );
}

function NewBarDialog({ mode, existing, onClose, onStart }: { mode: 'tpv' | 'pda'; existing: string[]; onClose: () => void; onStart: (name: string, waiterId?: string) => void }) {
  const [name, setName] = useState('');
  const [waiters, setWaiters] = useState<{ id: string; name: string }[]>([]);
  const [waiterId, setWaiterId] = useState('');
  useEffect(() => { if (mode === 'tpv') api('/api/service/waiters').then(setWaiters).catch(() => {}); }, [mode]);
  const reuse = existing.includes(name.trim().toLowerCase());
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Cliente de barra</h2>
        <label>Nombre o número que identifique al cliente<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
        {reuse && <p className="notice">Ya hay una cuenta abierta con ese nombre: se añadirá a esa misma cuenta.</p>}
        {mode === 'tpv' && (
          <label>Camarero asociado
            <select value={waiterId} onChange={(e) => setWaiterId(e.target.value)}>
              <option value="">Elige camarero…</option>
              {waiters.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        )}
        <div className="row">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={!name.trim() || (mode === 'tpv' && !waiterId)} onClick={() => onStart(name, waiterId || undefined)}>Continuar</button>
        </div>
      </div>
    </div>
  );
}
