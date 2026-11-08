import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { money } from '../lib/format';

/** Tarjeta digital del cliente: puntos y cupones disponibles. */
export default function Tarjeta() {
  const { token = '' } = useParams();
  const [d, setD] = useState<any>(null);
  const [qrs, setQrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState(false);
  useEffect(() => {
    api(`/api/public/card/${token}`).then(async (x) => {
      setD(x);
      setQrs(Object.fromEntries(await Promise.all(x.coupons.map(async (k: any) => [k.code, await QRCode.toDataURL(k.code, { width: 200, margin: 1 })]))));
    }).catch(() => setErr(true));
  }, [token]);
  if (err) return <div className="center-page"><div className="card login"><h2>Tarjeta no encontrada</h2></div></div>;
  if (!d) return <p className="muted" style={{ padding: '2rem' }}>Cargando…</p>;
  return (
    <div>
      <div className="hero"><div className="small" style={{ opacity: .85 }}>Tarjeta de cliente</div><h1 style={{ margin: 0 }}>{d.establishment}</h1></div>
      <div style={{ padding: '1rem', maxWidth: 480, margin: '0 auto' }} className="stack">
        <div className="card" style={{ textAlign: 'center' }}><div className="muted">Hola, {d.name}</div><div style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--green)' }}>{d.points}</div><div>puntos</div></div>
        <h2>Tus cupones</h2>
        {d.coupons.length === 0 && <p className="muted">Ahora mismo no tienes cupones.</p>}
        {d.coupons.map((k: any) => (
          <div key={k.code} className="card" style={{ textAlign: 'center' }}>
            <strong>{k.description || (k.kind === 'percent' ? `${k.value} % de descuento` : `${money(k.value)} de descuento`)}</strong>
            {qrs[k.code] && <img src={qrs[k.code]} alt="" style={{ width: 160, display: 'block', margin: '.5rem auto' }} />}
            <code>{k.code}</code>
            {k.valid_until && <div className="small muted">Válido hasta el {new Date(k.valid_until).toLocaleDateString('es-ES')}</div>}
          </div>
        ))}
        <p className="small muted">Enseña el código al personal al pagar.</p>
      </div>
    </div>
  );
}
