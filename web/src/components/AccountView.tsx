import { useCallback, useEffect, useState } from 'react';
import { api, newRequestId } from '../lib/api';
import { METHOD_LABEL, STATUS_LABEL, money, time, toCents } from '../lib/format';
import { useLive } from '../lib/realtime';
import { DocumentPrint } from './DocumentPrint';
import { ErrorText, Modal, useAction, useToast } from './ui';

interface Item { id: string; orderNumber: number; name: string; option: string | null; unitCents: number; qty: number; destination: string; course: number; status: string; parentItemId: string | null }
export interface Account {
  id: string; tableId: string | null; tableLabel: string | null; barName: string | null; waiterName: string | null; status: string;
  items: Item[]; payments: { id: string; method: string; amountCents: number; createdAt: string }[];
  totalCents: number; paidCents: number; pendingCents: number; undeliveredCount: number; heldCourses: number[];
}

const statusBadge = (s: string) => ({ ready: 'terra', received: 'terra', held: 'grey', cancelled: 'danger', delivered: '' } as Record<string, string>)[s] ?? 'warn';

export function AccountView({ accountId, onAddMore, onClosed }: { accountId: string; onAddMore?: () => void; onClosed?: () => void }) {
  const [acc, setAcc] = useState<Account | null>(null);
  const [paying, setPaying] = useState(false);
  const [doc, setDoc] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();

  const load = useCallback(() => { api<Account>(`/api/service/accounts/${accountId}`).then(setAcc).catch(() => {}); }, [accountId]);
  useEffect(load, [load]);
  useLive(load, ['orders', 'payments']);

  if (!acc) return <p className="muted">Cargando cuenta…</p>;
  const live = acc.items.filter((i) => i.status !== 'cancelled' && i.destination !== 'none');
  const ready = live.filter((i) => i.status === 'ready' || i.status === 'received');
  const notDelivered = live.filter((i) => i.status !== 'delivered' && i.status !== 'held');

  const setStatus = (ids: string[], status: string) => run(async () => {
    await api('/api/service/items', { method: 'PATCH', body: { itemIds: ids, status } });
    load();
  });
  const fire = () => run(async () => { const r = await api(`/api/service/accounts/${acc.id}/fire`, { body: {} }); toast(`${r.course}.º pase en marcha`); load(); });
  const proforma = () => run(async () => { const d = await api(`/api/service/accounts/${acc.id}/proforma`, { body: {} }); setDoc(d.id); });

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h2 style={{ margin: 0 }}>{acc.tableLabel ? `Mesa ${acc.tableLabel}` : `Barra · ${acc.barName}`}</h2>
          <span className="small muted">{acc.waiterName ? `Camarero: ${acc.waiterName}` : 'Sin camarero asignado'}</span>
        </div>
        <span className={`badge ${acc.status === 'paid' ? '' : 'warn'}`}>{acc.status === 'paid' ? 'Cobrada' : acc.status === 'open' ? 'Abierta' : 'Anulada'}</span>
      </div>

      {ready.length > 0 && (
        <div className="notice">
          <strong>{ready.length} producto(s) listos para servir.</strong>
          <div className="row mt">
            <button className="btn small" disabled={busy} onClick={() => setStatus(ready.filter((i) => i.status === 'ready').map((i) => i.id), 'received')}>Recibido</button>
            <button className="btn small primary" disabled={busy} onClick={() => setStatus(ready.map((i) => i.id), 'delivered')}>Entregado en mesa</button>
          </div>
        </div>
      )}

      <table className="list">
        <thead><tr><th>Producto</th><th>Estado</th><th className="right">Importe</th><th></th></tr></thead>
        <tbody>
          {acc.items.map((i) => (
            <tr key={i.id} style={i.status === 'cancelled' ? { opacity: .5, textDecoration: 'line-through' } : undefined}>
              {i.parentItemId
                ? <td style={{ paddingLeft: '1.5rem' }}>↳ {i.name}<div className="small muted">{i.course}.º pase</div></td>
                : <td>{i.qty} × {i.name}{i.option && <div className="small muted">{i.option}</div>}<div className="small muted">Pedido {i.orderNumber}{i.destination !== 'none' && ` · ${i.course}.º pase`}</div></td>}
              <td>{i.destination === 'none' && i.status !== 'cancelled' ? <span className="badge terra">Menú</span> : <span className={`badge ${statusBadge(i.status)}`}>{STATUS_LABEL[i.status]}</span>}</td>
              <td className="right">{i.parentItemId ? '' : money(i.unitCents * i.qty)}</td>
              <td className="right">
                {['ready', 'received', 'new', 'preparing'].includes(i.status) && i.destination !== 'none' && acc.status === 'open' && (
                  <button className="btn small ghost" title="Marcar entregado" disabled={busy} onClick={() => setStatus([i.id], 'delivered')}>✓</button>
                )}
                {['held', 'new'].includes(i.status) && acc.status === 'open' && (
                  <button className="btn small ghost" title="Anular" disabled={busy} onClick={() => { if (confirm(`¿Anular ${i.name}?`)) setStatus([i.id], 'cancelled'); }}>✕</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="card">
        <div className="spread"><span>Total</span><strong>{money(acc.totalCents)}</strong></div>
        {acc.paidCents > 0 && <div className="spread small"><span>Cobrado</span><span>{acc.payments.map((p) => `${METHOD_LABEL[p.method]} ${money(p.amountCents)}`).join(' · ')}</span></div>}
        <div className="spread"><span>Pendiente</span><strong style={{ color: acc.pendingCents ? 'var(--terra)' : undefined }}>{money(acc.pendingCents)}</strong></div>
      </div>

      <ErrorText error={error} />
      {acc.status === 'open' && (
        <div className="row">
          {onAddMore && <button className="btn" onClick={onAddMore}>+ Añadir consumición</button>}
          {acc.heldCourses.length > 0 && <button className="btn terra" disabled={busy} onClick={fire}>Marchar {acc.heldCourses[0]}.º pase</button>}
          {notDelivered.length > 0 && <button className="btn" disabled={busy} onClick={() => { if (confirm('¿Se han servido realmente todos los productos?')) setStatus(notDelivered.map((i) => i.id), 'delivered'); }}>Todo entregado</button>}
          <button className="btn" disabled={busy || !live.length} onClick={proforma}>Imprimir cuenta</button>
          <button className="btn primary" disabled={!acc.pendingCents} onClick={() => setPaying(true)}>Cobrar</button>
        </div>
      )}
      {acc.status === 'paid' && <TicketButton accountId={acc.id} onOpen={setDoc} />}

      {paying && <PayModal acc={acc} onClose={() => setPaying(false)} onDone={(r) => {
        setPaying(false); load();
        if (r.documentId) { setDoc(r.documentId); onClosed?.(); }
      }} />}
      {doc && <DocumentPrint id={doc} onClose={() => setDoc(null)} />}
    </div>
  );
}

function TicketButton({ accountId, onOpen }: { accountId: string; onOpen: (id: string) => void }) {
  const [docs, setDocs] = useState<{ id: string; type: string }[]>([]);
  useEffect(() => { api(`/api/service/accounts/${accountId}/documents`).then(setDocs).catch(() => {}); }, [accountId]);
  const t = docs.find((d) => d.type === 'simplified');
  return t ? <button className="btn" onClick={() => onOpen(t.id)}>Imprimir ticket</button> : null;
}

function PayModal({ acc, onClose, onDone }: { acc: Account; onClose: () => void; onDone: (r: any) => void }) {
  const [method, setMethod] = useState<'cash' | 'card' | 'bizum'>('cash');
  const [amount, setAmount] = useState((acc.pendingCents / 100).toFixed(2));
  const [tendered, setTendered] = useState('');
  // Una clave por intento de cobro: una doble pulsación o un reintento no cobran dos veces.
  const [key] = useState(newRequestId);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const amountCents = toCents(amount || '0');
  const tenderedCents = tendered ? toCents(tendered) : null;
  const change = method === 'cash' && tenderedCents != null ? tenderedCents - amountCents : null;

  const pay = () => run(async () => {
    const r = await api(`/api/service/accounts/${acc.id}/payments`, { body: { idempotencyKey: key, method, amountCents, tenderedCents: method === 'cash' ? tenderedCents : null } });
    toast(r.duplicate ? 'Este cobro ya estaba registrado; no se ha cobrado dos veces.' : r.accountStatus === 'paid' ? 'Cuenta cobrada' : `Cobro parcial registrado. Quedan ${money(r.pendingCents)}`);
    onDone(r);
  });

  return (
    <Modal title={`Cobrar · pendiente ${money(acc.pendingCents)}`} onClose={onClose}>
      {acc.undeliveredCount > 0 && <p className="notice">Hay {acc.undeliveredCount} producto(s) sin entregar. Márcalos como entregados cuando se hayan servido.</p>}
      <div className="row" style={{ marginBottom: '1rem' }}>
        {(['cash', 'card', 'bizum'] as const).map((m) => <button key={m} className={`chip ${method === m ? 'on' : ''}`} onClick={() => setMethod(m)}>{METHOD_LABEL[m]}</button>)}
      </div>
      <label>Importe a cobrar (puedes dividir la cuenta)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      {method === 'cash' && (
        <>
          <label>Efectivo entregado<input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder="Opcional" /></label>
          {change != null && <p className={change < 0 ? 'error' : ''}><strong>{change < 0 ? 'Falta' : 'Cambio'}: {money(Math.abs(change))}</strong></p>}
        </>
      )}
      {method !== 'cash' && <p className="small muted">Registra el cobro cuando el datáfono o Bizum lo hayan confirmado. Este registro no realiza la operación bancaria.</p>}
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !(amountCents > 0) || (change != null && change < 0)} onClick={pay}>
        {busy ? 'Registrando…' : `Confirmar cobro de ${money(amountCents || 0)}`}
      </button>
    </Modal>
  );
}
