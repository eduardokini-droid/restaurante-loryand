import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { ErrorText, Modal, useAction } from './ui';

/**
 * "Acceso camareros" en el TPV: el camarero pulsa su nombre y escanea un QR de un solo uso (2 minutos)
 * con su teléfono. Allí debe escribir su PIN: si otro lee el código, sin ese PIN no entra.
 */
export function WaiterAccess({ onClose }: { onClose: () => void }) {
  const [waiters, setWaiters] = useState<{ id: string; name: string }[]>([]);
  const [code, setCode] = useState<{ token: string; waiter: string; waiterId: string; expiresAt: string; img: string } | null>(null);
  const [left, setLeft] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { api('/api/service/waiters').then(setWaiters).catch(() => {}); }, []);

  const generate = (w: { id: string; name: string }) => run(async () => {
    const r = await api('/api/service/waiter-access', { body: { waiterId: w.id } });
    setDone(null);
    setCode({ token: r.token, waiter: r.waiter, waiterId: w.id, expiresAt: r.expiresAt, img: await QRCode.toDataURL(`${location.origin}${r.path}`, { width: 360, margin: 2 }) });
  });

  // Cuenta atrás y comprobación de si ya se ha usado.
  useEffect(() => {
    if (!code) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(code.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const t1 = setInterval(tick, 1000);
    const t2 = setInterval(() => {
      api(`/api/auth/waiter-access/${code.token}`).then((s) => {
        if (!s.valid && new Date(code.expiresAt).getTime() > Date.now()) { setDone(code.waiter); setCode(null); setTimeout(() => setDone(null), 3000); }
      }).catch(() => {});
    }, 2000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [code]);

  return (
    <Modal title="Acceso de camareros" onClose={onClose}>
      {done && <p className="notice ok"><strong>{done} ha entrado en su teléfono.</strong></p>}
      {code ? (
        <div className="stack" style={{ textAlign: 'center' }}>
          <h2 style={{ margin: 0 }}>{code.waiter}</h2>
          {left > 0 ? (
            <>
              <img src={code.img} alt={`Código de acceso de ${code.waiter}`} style={{ width: 260, margin: '0 auto' }} />
              <p>Escanéalo con tu teléfono y escribe <strong>tu PIN</strong>.</p>
              <p className="small muted">Válido una sola vez · caduca en {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>
            </>
          ) : <p className="notice">El código ha caducado.</p>}
          <div className="row" style={{ justifyContent: 'center' }}>
            {left === 0 && <button className="btn primary" disabled={busy} onClick={() => generate({ id: code.waiterId, name: code.waiter })}>Generar otro</button>}
            <button className="btn" onClick={() => setCode(null)}>Elegir otro camarero</button>
          </div>
        </div>
      ) : (
        <>
          <p className="small muted">Pulsa tu nombre. Aparecerá un código para entrar en tu teléfono con tu PIN. Cada uno entra con su propia identidad: así comandas y cobros quedan a tu nombre.</p>
          <div className="grid tiles">
            {waiters.map((w) => <button key={w.id} className="product-btn" style={{ alignItems: 'center', justifyContent: 'center' }} disabled={busy} onClick={() => generate(w)}><strong style={{ fontSize: '1.1rem' }}>{w.name}</strong></button>)}
          </div>
          {waiters.length === 0 && <p className="muted">No hay camareros activos. Créalos en Gestión → Camareros.</p>}
        </>
      )}
      <ErrorText error={error} />
    </Modal>
  );
}
