import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { ErrorText, useAction } from '../components/ui';

/** Página del QR del ticket: el cliente pide su factura completa o la descarga si ya la pidió. */
export default function Factura() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { setD(null); api(`/api/public/invoice/${token}`).then(setD).catch((e) => setErr(e.message)); }, [token]);
  useEffect(load, [load]);
  if (err) return <div className="center-page"><div className="card login"><h2>Enlace no válido</h2><p className="muted">{err}</p></div></div>;
  if (!d) return <p className="muted" style={{ padding: '2rem' }}>Cargando…</p>;
  return (
    <div>
      <div className="hero no-print"><div className="small" style={{ opacity: .85 }}>Factura</div>
        <div className="hero-title">{d.logoUrl && <img src={d.logoUrl} alt="" className="hero-logo" />}<h1 style={{ margin: 0 }}>{d.establishment}</h1></div></div>
      <div style={{ padding: '1rem', maxWidth: 560, margin: '0 auto' }} className="stack">
        {d.document ? <FullInvoice d={d} /> : (
          <>
            <div className="card no-print">
              <div className="spread"><span>Ticket <code>{d.code}</code></span><strong>{money(d.totalCents)}</strong></div>
              <div className="small muted">{dateTime(d.createdAt)}</div>
            </div>
            {d.canRequest && <RequestForm token={token} onDone={(t) => navigate(`/factura/${t}`)} />}
            {d.reason === 'already' && d.fullToken && <div className="card"><p>La factura completa de este ticket ya está hecha.</p><button className="btn primary block" onClick={() => navigate(`/factura/${d.fullToken}`)}>Ver la factura</button></div>}
            {d.reason === 'other_quarter' && <p className="notice">La factura completa solo se puede pedir con este código dentro del mismo trimestre de la compra. Pídela en el establecimiento.</p>}
            {d.reason === 'voided' && <p className="notice">Este ticket está anulado.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function RequestForm({ token, onDone }: { token: string; onDone: (token: string) => void }) {
  const [f, setF] = useState({ name: '', taxId: '', foreign: false, address: '', postalCode: '', city: '', email: '' });
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const send = (e: React.FormEvent) => { e.preventDefault(); run(async () => onDone((await api<{ token: string }>(`/api/public/invoice/${token}`, { body: f })).token)); };
  return (
    <form className="card stack" onSubmit={send}>
      <h2 style={{ margin: 0 }}>Pedir factura completa</h2>
      <p className="small muted" style={{ margin: 0 }}>Escribe los datos fiscales que deben aparecer en la factura. Sustituye a este ticket y solo se puede pedir una vez: revísalos bien.</p>
      <label>Nombre o razón social<input autoComplete="organization" value={f.name} onChange={set('name')} required /></label>
      <label>{f.foreign ? 'Número de identificación fiscal' : 'NIF, NIE o CIF'}<input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value.toUpperCase() })} required /></label>
      <label className="check"><input type="checkbox" checked={f.foreign} onChange={(e) => setF({ ...f, foreign: e.target.checked })} /> <span>Empresa o persona de otro país</span></label>
      <label>Dirección<input autoComplete="street-address" value={f.address} onChange={set('address')} required /></label>
      <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 2fr' }}>
        <label>Código postal<input autoComplete="postal-code" inputMode="numeric" value={f.postalCode} onChange={set('postalCode')} /></label>
        <label>Localidad<input autoComplete="address-level2" value={f.city} onChange={set('city')} /></label>
      </div>
      <label>Correo para recibirla (opcional)<input type="email" autoComplete="email" value={f.email} onChange={set('email')} /></label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy}>{busy ? 'Emitiendo…' : 'Emitir mi factura'}</button>
      <p className="small muted" style={{ margin: 0 }}>Tus datos solo se usan para emitir la factura, que el establecimiento debe conservar por obligación fiscal.</p>
    </form>
  );
}

function FullInvoice({ d }: { d: any }) {
  const doc = d.document; const p = doc.payload; const c = p.customer;
  return (
    <>
      <div className="row no-print"><button className="btn primary" onClick={() => window.print()}>Imprimir o guardar en PDF</button></div>
      <div className="printable card">
        <div className="doc" style={{ maxWidth: '100%' }}>
          {d.logoUrl && <div className="c"><img src={d.logoUrl} alt="" style={{ maxWidth: 160, maxHeight: 70, objectFit: 'contain' }} /></div>}
          <div className="c"><strong>{p.issuer.name}</strong></div>
          {p.issuer.legal_name && <div className="c">{p.issuer.legal_name}</div>}
          {p.issuer.tax_id && <div className="c">NIF {p.issuer.tax_id}</div>}
          {p.issuer.address && <div className="c">{p.issuer.address} {p.issuer.postal_code} {p.issuer.city}</div>}
          <hr />
          <div><strong>FACTURA</strong> {doc.series}-{String(doc.number).padStart(5, '0')}</div>
          <div>{dateTime(doc.created_at)}</div>
          <hr />
          <div><strong>Cliente:</strong> {c.name}</div><div>NIF {c.taxId}</div><div>{c.address} {c.postalCode} {c.city}</div>
          <hr />
          {p.lines.filter((l: any) => l.unitCents > 0 || !l.name.includes('·')).map((l: any, i: number) => (
            <div key={i} className="l"><span>{l.qty} {l.name}</span><span>{money(l.unitCents * l.qty)}</span></div>
          ))}
          {p.discounts?.map((x: any, i: number) => <div key={`d${i}`} className="l"><span>{x.label}</span><span>-{money(x.amountCents)}</span></div>)}
          <hr />
          <div className="l"><strong>TOTAL</strong><strong>{money(doc.total_cents)}</strong></div>
          {p.vat.map((v: any) => <div key={v.rate} className="l"><span>IVA {v.rate}% · base {money(v.baseCents)}</span><span>{money(v.vatCents)}</span></div>)}
        </div>
      </div>
      <p className="small muted no-print">Guarda esta página: desde este enlace puedes volver a descargar la factura.</p>
    </>
  );
}
