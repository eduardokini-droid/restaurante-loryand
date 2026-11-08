import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { ErrorText, useAction } from '../components/ui';

/** Página de pago del cliente. Redirige a la pasarela del banco; solo la confirmación del banco da el pago por hecho. */
export default function Pagar() {
  const { token = '' } = useParams();
  const back = new URLSearchParams(location.search).get('resultado');
  const [d, setD] = useState<any>(null);
  const [missing, setMissing] = useState(false);
  const { busy, error, run } = useAction();
  const load = useCallback(() => { api(`/api/public/pay/${token}`).then(setD).catch(() => setMissing(true)); }, [token]);
  useEffect(load, [load]);
  // Al volver del banco, se consulta el estado hasta recibir su confirmación.
  useEffect(() => {
    if (!back || d?.status === 'paid' || d?.status === 'failed') return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [back, d?.status, load]);

  const pay = (method: 'card' | 'bizum') => run(async () => {
    const f = await api(`/api/public/pay/${token}/start`, { body: { method } });
    const form = document.createElement('form');
    form.method = 'POST'; form.action = f.url;
    for (const [k, v] of Object.entries(f.fields as Record<string, string>)) {
      const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.appendChild(i);
    }
    document.body.appendChild(form); form.submit();
  });

  if (missing) return <div className="center-page"><div className="card login"><h2>Pago no encontrado</h2><p>Pide un nuevo código al personal.</p></div></div>;
  if (!d) return <p className="muted" style={{ padding: '2rem' }}>Cargando…</p>;
  return (
    <div>
      <div className="hero"><div className="small" style={{ opacity: .85 }}>{d.place}</div><h1 style={{ margin: 0 }}>{d.establishment}</h1></div>
      <div style={{ padding: '1rem', maxWidth: 460, margin: '0 auto' }} className="stack">
        {d.environment === 'test' && <p className="notice small">Entorno de pruebas: no se cobrará dinero real.</p>}
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="muted">Importe a pagar</div>
          <div style={{ fontSize: '2.6rem', fontWeight: 800, color: 'var(--green)' }}>{money(d.amountCents)}</div>
        </div>
        {d.status === 'paid' && <div className="notice ok"><strong>Pago confirmado por el banco.</strong> ¡Gracias! Ya puedes avisar al personal si necesitas el ticket.</div>}
        {d.status === 'failed' && <div className="notice">El banco ha rechazado el pago. Puedes intentarlo con otro método o pagar al personal.</div>}
        {d.status === 'cancelled' && <div className="notice">Este código de pago se ha retirado. Pide uno nuevo al personal.</div>}
        {d.status === 'expired' && <div className="notice">Este código ha caducado. Pide uno nuevo al personal.</div>}
        {d.status === 'conflict' && <div className="notice">El pago se ha recibido y el personal lo está revisando. No vuelvas a pagar.</div>}
        {d.status === 'pending' && back && <div className="notice">Esperando la confirmación del banco… No cierres esta página ni vuelvas a pagar.</div>}
        {d.status === 'pending' && !back && (
          <>
            {d.methods.card && <button className="btn primary block" disabled={busy} onClick={() => pay('card')}>Pagar con tarjeta</button>}
            {d.methods.bizum && <button className="btn terra block" disabled={busy} onClick={() => pay('bizum')}>Pagar con Bizum</button>}
            <p className="small muted">Se abrirá la pasarela segura del banco. Introduce allí tus datos: este establecimiento no los ve.</p>
          </>
        )}
        {d.status === 'failed' && (
          <div className="row">
            {d.methods.card && <button className="btn" disabled={busy} onClick={() => pay('card')}>Reintentar con tarjeta</button>}
          </div>
        )}
        <ErrorText error={error} />
      </div>
    </div>
  );
}
