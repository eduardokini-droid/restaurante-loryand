import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, minutesSince } from '../lib/format';
import { useFloor, FloorGrid, TableControls, type FloorTable } from '../components/Floor';
import { AccountView } from '../components/AccountView';
import { Modal } from '../components/ui';

/** Panel de control: lo que requiere atención ahora mismo. */
export default function Sala() {
  const { floor, reload, connected } = useFloor();
  const [open, setOpen] = useState<FloorTable | null>(null);
  const [requests, setRequests] = useState<any[]>([]);
  useEffect(() => { api('/api/service/requests').then(setRequests).catch(() => {}); }, [floor]);
  if (!floor) return <p className="muted">Cargando…</p>;
  const busy = floor.tables.filter((t) => t.account_id);
  const pending = floor.tables.reduce((s, t) => s + (t.total_cents - t.paid_cents), 0) + floor.bar.reduce((s, b) => s + b.total_cents - b.paid_cents, 0);
  const current = open && floor.tables.find((t) => t.id === open.id);
  return (
    <div className="stack">
      <div className="spread"><h1>Sala</h1>{!connected && <span className="badge danger">Sin conexión en tiempo real</span>}</div>
      <div className="grid cols-2">
        <div className="card"><div className="muted small">Mesas con cuenta abierta</div><h2>{busy.length} / {floor.tables.length}</h2></div>
        <div className="card"><div className="muted small">Pendiente de cobro</div><h2>{money(pending)}</h2></div>
        <div className="card"><div className="muted small">Productos listos sin servir</div><h2>{floor.tables.reduce((s, t) => s + t.ready, 0)}</h2></div>
        <div className="card"><div className="muted small">Avisos de clientes</div><h2>{requests.length}</h2>
          {requests.map((r) => <div key={r.id} className="small">Mesa {r.table_label} · {({ pay: 'quiere pagar', waiter: 'llama al camarero', other: 'otra atención' } as any)[r.kind]} · {minutesSince(r.created_at)} min</div>)}
        </div>
      </div>
      <FloorGrid tables={floor.tables} onPick={setOpen} />
      {current && (
        <Modal title={`Mesa ${current.label}`} onClose={() => setOpen(null)}>
          {current.account_id ? <AccountView accountId={current.account_id} onClosed={reload} /> : <p className="muted">Sin cuenta abierta. Usa el TPV o la PDA para tomar la comanda.</p>}
          <div className="mt"><TableControls table={current} onChanged={reload} /></div>
        </Modal>
      )}
    </div>
  );
}
