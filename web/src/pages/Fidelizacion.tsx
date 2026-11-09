import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { dateTime, money, toCents } from '../lib/format';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';
import { useSession } from '../lib/session';
import { getSelectedEstablishment } from '../lib/api';

const couponText = (k: any) => (k.kind === 'percent' ? `${k.value} % de descuento` : `${money(k.value)} de descuento`);

/** Fidelización y cupones (capítulo 23). */
export default function Fidelizacion() {
  const [q, setQ] = useState('');
  const [customers, setCustomers] = useState<any[]>([]);
  const [coupons, setCoupons] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [couponFor, setCouponFor] = useState<any | null | undefined>(undefined);
  const [card, setCard] = useState<any | null>(null);
  const { error, run } = useAction();
  const load = useCallback(() => {
    api(`/api/loyalty/customers?q=${encodeURIComponent(q)}`).then(setCustomers).catch(() => {});
    api('/api/loyalty/coupons').then(setCoupons).catch(() => {});
  }, [q]);
  useEffect(load, [load]);
  const inactive = customers.filter((c) => c.inactive).length;
  const exportData = async (c: any) => {
    const res = await fetch(`/api/loyalty/customers/${c.id}/export`, { headers: { 'x-establishment-id': getSelectedEstablishment() ?? '' } });
    if (!res.ok) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `datos-${c.name.replace(/\s+/g, '-').toLowerCase()}.json`; a.click();
  };
  const erase = (c: any) => run(async () => {
    if (!confirm(`¿Suprimir los datos de ${c.name}? Se borran su ficha, puntos y cupones. Las ventas se conservan sin su nombre. No se puede deshacer.`)) return;
    await api(`/api/loyalty/customers/${c.id}/erase`, { body: {} }); load();
  });
  return (
    <div className="stack">
      <div className="spread"><h1>Fidelización</h1>
        <span className="row"><button className="btn" onClick={() => setCouponFor(null)}>Crear cupón general</button><button className="btn primary" onClick={() => setAdding(true)}>+ Nuevo cliente</button></span></div>
      <div className="grid cols-2">
        <div className="card"><div className="muted small">Clientes</div><h2>{customers.length}</h2></div>
        <div className="card"><div className="muted small">Más de 45 días sin venir</div><h2>{inactive}</h2></div>
      </div>
      <input placeholder="Buscar por nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
      <ErrorText error={error} />
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="list">
          <thead><tr><th>Cliente</th><th className="right">Visitas</th><th className="right">Gastado</th><th className="right">Puntos</th><th>Última visita</th><th></th></tr></thead>
          <tbody>{customers.map((c) => (
            <tr key={c.id}>
              <td><strong>{c.name}</strong><div className="small muted">{c.phone}{c.email && ` · ${c.email}`}</div>{!c.marketing_consent && <div className="small muted">Sin consentimiento para comunicaciones</div>}</td>
              <td className="right">{c.visits}</td><td className="right">{money(c.spent_cents)}</td><td className="right"><strong>{c.points}</strong></td>
              <td className="small">{c.last_visit ? dateTime(c.last_visit) : '—'}{c.inactive && c.last_visit && <div className="badge warn">+45 días</div>}</td>
              <td className="right"><div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                <button className="btn small" onClick={() => setCouponFor(c)}>Crear cupón QR</button>
                <button className="btn small ghost" onClick={() => setCard(c)}>Tarjeta digital</button>
                <button className="btn small ghost" title="Derecho de acceso: descarga todos sus datos" onClick={() => exportData(c)}>Exportar datos</button>
                <button className="btn small ghost danger" title="Derecho de supresión" onClick={() => erase(c)}>Suprimir</button>
              </div></td>
            </tr>
          ))}</tbody>
        </table>
        <p className="small muted">Los indicadores dependen de asociar el cliente a su cuenta al cobrar. Una ficha no implica permiso para enviar publicidad.</p>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <h3>Cupones</h3>
        <table className="list">
          <thead><tr><th>Código</th><th>Descuento</th><th>Cliente</th><th>Usos</th><th>Válido hasta</th><th></th></tr></thead>
          <tbody>{coupons.map((k) => (
            <tr key={k.id} style={k.active ? undefined : { opacity: .5 }}>
              <td><code>{k.code}</code>{k.description && <div className="small muted">{k.description}</div>}</td>
              <td>{couponText(k)}{k.min_total_cents > 0 && <div className="small muted">mínimo {money(k.min_total_cents)}</div>}</td>
              <td>{k.customer_name ?? 'General'}</td><td>{k.uses}{k.max_uses ? ` / ${k.max_uses}` : ''}</td>
              <td className="small">{k.valid_until ? new Date(k.valid_until).toLocaleDateString('es-ES') : 'Sin caducidad'}</td>
              <td className="right"><button className="btn small ghost" onClick={() => run(async () => { await api(`/api/loyalty/coupons/${k.id}`, { method: 'PATCH', body: { active: !k.active } }); load(); })}>{k.active ? 'Desactivar' : 'Activar'}</button></td>
            </tr>
          ))}</tbody>
        </table>
        <p className="small muted">Un cupón es un descuento sobre la cuenta, no dinero cobrado: el cierre de caja refleja el importe ya descontado.</p>
      </div>
      {adding && <CustomerForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {couponFor !== undefined && <CouponForm customer={couponFor} onClose={() => setCouponFor(undefined)} onDone={() => { setCouponFor(undefined); load(); }} />}
      {card && <CardModal c={card} onClose={() => setCard(null)} />}
    </div>
  );
}

export function CustomerForm({ onClose, onDone, initialName = '' }: { onClose: () => void; onDone: (c: any) => void; initialName?: string }) {
  const [f, setF] = useState({ name: initialName, phone: '', email: '', notes: '', marketingConsent: false, privacyAccepted: false });
  const { busy, error, run } = useAction();
  const { me } = useSession();
  const [notice, setNotice] = useState('');
  useEffect(() => { if (me?.establishment?.slug) api<any>(`/api/public/legal/${me.establishment.slug}`).then((t) => setNotice(t.layers.loyalty)).catch(() => {}); }, [me?.establishment?.slug]);
  return (
    <Modal title="Nuevo cliente" onClose={onClose}>
      <label>Nombre<input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Teléfono<input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label>Correo (opcional)<input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <label>Notas (preferencias, alergias…)<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
      {notice && <details className="small muted"><summary>Información que hay que dar al cliente</summary><p style={{ lineHeight: 1.45 }}>{notice}</p></details>}
      <label className="check"><input type="checkbox" checked={f.privacyAccepted} onChange={(e) => setF({ ...f, privacyAccepted: e.target.checked })} /> <span>He informado al cliente (cartel o texto de arriba) y <strong>acepta entrar en el programa</strong></span></label>
      <label className="check"><input type="checkbox" checked={f.marketingConsent} onChange={(e) => setF({ ...f, marketingConsent: e.target.checked })} /> <span>Acepta recibir comunicaciones comerciales (opcional)</span></label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !f.name.trim() || !f.privacyAccepted} onClick={() => run(async () => onDone(await api('/api/loyalty/customers', { body: f })))}>Guardar ficha</button>
    </Modal>
  );
}

function CouponForm({ customer, onClose, onDone }: { customer: any | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ kind: 'percent', value: '10', minTotal: '', validUntil: '', maxUses: '1', description: '', code: '' });
  const [created, setCreated] = useState<any>(null);
  const [img, setImg] = useState('');
  const { busy, error, run } = useAction();
  const toast = useToast();
  const save = () => run(async () => {
    const k = await api('/api/loyalty/coupons', { body: {
      customerId: customer?.id ?? null, kind: f.kind, value: f.kind === 'percent' ? Number(f.value) : toCents(f.value),
      minTotalCents: f.minTotal ? toCents(f.minTotal) : 0, validUntil: f.validUntil || null, maxUses: f.maxUses ? Number(f.maxUses) : null,
      description: f.description, ...(f.code ? { code: f.code } : {}),
    } });
    setCreated(k); setImg(await QRCode.toDataURL(k.code, { width: 280, margin: 1 })); toast('Cupón creado');
  });
  return (
    <Modal title={customer ? `Cupón para ${customer.name}` : 'Cupón general'} onClose={created ? onDone : onClose}>
      {created ? (
        <div className="stack" style={{ textAlign: 'center' }}>
          <img src={img} alt="QR del cupón" style={{ width: 220, margin: '0 auto' }} />
          <div><code style={{ fontSize: '1.4rem' }}>{created.code}</code></div>
          <p className="small">{couponText(created)}. Al cobrar, introduce este código en la cuenta. Prueba el canje antes de compartirlo.</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <a className="btn" href={img} download={`cupon-${created.code}.png`}>Descargar QR</a>
            <button className="btn primary" onClick={onDone}>Hecho</button>
          </div>
        </div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: '.75rem' }}>
            <button className={`chip ${f.kind === 'percent' ? 'on' : ''}`} onClick={() => setF({ ...f, kind: 'percent', value: '10' })}>Porcentaje</button>
            <button className={`chip ${f.kind === 'amount' ? 'on' : ''}`} onClick={() => setF({ ...f, kind: 'amount', value: '5' })}>Importe fijo</button>
          </div>
          <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <label>{f.kind === 'percent' ? 'Descuento (%)' : 'Descuento (€)'}<input inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></label>
            <label>Consumo mínimo (€)<input inputMode="decimal" value={f.minTotal} onChange={(e) => setF({ ...f, minTotal: e.target.value })} placeholder="Sin mínimo" /></label>
            <label>Válido hasta<input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></label>
            <label>Usos máximos<input type="number" min={1} value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} placeholder="Ilimitado" /></label>
          </div>
          <label>Descripción (la ve el cliente)<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Ej.: Postre gratis en tu próxima visita" /></label>
          <label>Código (opcional, se genera solo)<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></label>
          <ErrorText error={error} />
          <button className="btn primary block" disabled={busy || !f.value} onClick={save}>Crear cupón</button>
        </>
      )}
    </Modal>
  );
}

function CardModal({ c, onClose }: { c: any; onClose: () => void }) {
  const url = `${location.origin}/tarjeta/${c.card_token}`;
  const [img, setImg] = useState('');
  useEffect(() => { QRCode.toDataURL(url, { width: 280, margin: 1 }).then(setImg); }, [url]);
  return (
    <Modal title={`Tarjeta digital de ${c.name}`} onClose={onClose}>
      <p className="small">El cliente puede guardar este enlace en su móvil para ver sus puntos y cupones.</p>
      {img && <img src={img} alt="QR de la tarjeta" style={{ width: 220, display: 'block', margin: '0 auto' }} />}
      <p className="small" style={{ wordBreak: 'break-all' }}><code>{url}</code></p>
      <div className="row"><button className="btn" onClick={() => navigator.clipboard?.writeText(url)}>Copiar enlace</button>{img && <a className="btn" href={img} download="tarjeta.png">Descargar QR</a>}</div>
    </Modal>
  );
}
