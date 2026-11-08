import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { money, time } from '../lib/format';
import { useLive } from '../lib/realtime';
import { ErrorText, Modal, useAction, useToast } from './ui';

const STATUS: Record<string, [string, string]> = {
  pending: ['Esperando al cliente', 'warn'], processing: ['En el banco', 'warn'], paid: ['Pagado', ''],
  failed: ['Rechazado por el banco', 'danger'], cancelled: ['Retirado', 'grey'], conflict: ['Revisar: cobro sin aplicar', 'danger'],
};

/** "Cobrar con QR · Tarjeta / Bizum": el cliente escanea y paga en la pasarela del banco. */
export function OnlinePaymentModal({ accountId, onClose, onPaid }: { accountId: string; onClose: () => void; onPaid: () => void }) {
  const [p, setP] = useState<{ id: string; url: string; amountCents: number; environment: string } | null>(null);
  const [img, setImg] = useState('');
  const [status, setStatus] = useState('pending');
  const { busy, error, run } = useAction();
  const toast = useToast();

  useEffect(() => {
    run(async () => {
      const r = await api(`/api/service/accounts/${accountId}/online-payment`, { body: {} });
      setP(r); setImg(await QRCode.toDataURL(r.url, { width: 320, margin: 1 }));
    });
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => {
    if (!p) return;
    api<any[]>(`/api/service/accounts/${accountId}/online-payments`).then((list) => {
      const cur = list.find((x) => x.id === p.id);
      if (cur && cur.status !== status) {
        setStatus(cur.status);
        if (cur.status === 'paid') { toast('Pago confirmado por el banco'); onPaid(); }
      }
    }).catch(() => {});
  }, [p, accountId, status, toast, onPaid]);
  useLive(refresh, ['payments'], { intervalMs: 4000 });

  const cancel = () => run(async () => { await api(`/api/service/online-payments/${p!.id}/cancel`, { body: {} }); setStatus('cancelled'); toast('QR retirado'); });

  return (
    <Modal title={p ? `Cobrar ${money(p.amountCents)} con QR` : 'Cobro online'} onClose={onClose}>
      <ErrorText error={error} />
      {p && (
        <div className="stack" style={{ textAlign: 'center' }}>
          {p.environment === 'test' && <p className="notice small">Entorno de PRUEBAS: no se cobra dinero real.</p>}
          {status === 'pending' && img && <img src={img} alt="QR de pago" style={{ width: 240, margin: '0 auto' }} />}
          <div><span className={`badge ${STATUS[status][1]}`}>{STATUS[status][0]}</span></div>
          {status === 'pending' && <p className="small">El cliente escanea el código y paga con tarjeta o Bizum. El importe queda fijado: lo que se añada después se cobra aparte. Solo cuenta la confirmación del banco.</p>}
          {status === 'paid' && <p>La cuenta queda cobrada y el ticket emitido.</p>}
          {status === 'failed' && <p className="small">El banco ha rechazado el pago. Puedes cobrar por otro medio.</p>}
          <div className="row" style={{ justifyContent: 'center' }}>
            {status === 'pending' && <button className="btn" onClick={() => navigator.clipboard?.writeText(p.url)}>Copiar enlace</button>}
            {status === 'pending' && <button className="btn danger" disabled={busy} onClick={cancel}>Retirar QR</button>}
            <button className="btn primary" onClick={onClose}>Cerrar</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Aviso de cobros bancarios que no se pudieron aplicar (hay que revisarlos y devolverlos en Redsys). */
export function OnlineConflicts() {
  const [list, setList] = useState<any[]>([]);
  const load = useCallback(() => { api('/api/service/online-payments/conflicts').then(setList).catch(() => {}); }, []);
  useEffect(load, [load]);
  useLive(load, ['payments']);
  if (!list.length) return null;
  return (
    <div className="notice">
      <strong>Cobros online por revisar ({list.length})</strong>
      {list.map((c) => <div key={c.id} className="small">{c.place} · {money(c.amount_cents)} · pedido Redsys <code>{c.order_code}</code> · {time(c.updated_at)} — {c.error}</div>)}
      <div className="small">El banco cobró al cliente pero el programa no pudo aplicarlo (por ejemplo, porque ya se había cobrado en efectivo). Consulta la referencia en Redsys y devuelve el importe si corresponde.</div>
    </div>
  );
}
