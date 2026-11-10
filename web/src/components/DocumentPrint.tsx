import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useSession } from '../lib/session';
import { api } from '../lib/api';
import { DOC_LABEL, dateTime, money } from '../lib/format';
import { ErrorText, Modal, useAction, useToast } from './ui';

export function DocumentPrint({ id, onClose }: { id: string; onClose: () => void }) {
  const [docId, setDocId] = useState(id);
  const [d, setD] = useState<any>(null);
  const [converting, setConverting] = useState(false);
  useEffect(() => { api(`/api/service/documents/${docId}`).then(setD).catch(() => {}); }, [docId]);
  const { me } = useSession();
  const settings = (me?.establishment?.settings ?? {}) as Record<string, unknown>;
  const logo = settings.ticketLogo !== false ? me?.establishment?.logo_url : null;
  const [qr, setQr] = useState('');
  const invoiceUrl = d && d.type === 'simplified' && d.status === 'valid' && settings.ticketInvoiceQr !== false ? `${location.origin}/factura/${d.public_token}` : '';
  useEffect(() => { if (invoiceUrl) QRCode.toDataURL(invoiceUrl, { width: 180, margin: 1 }).then(setQr); else setQr(''); }, [invoiceUrl]);
  if (!d) return null;
  const p = d.payload;
  const c = p.customer;
  return (
    <Modal title={DOC_LABEL[d.type]} onClose={onClose}>
      {d.status === 'replaced' && <p className="notice small">Este ticket se sustituyó por una factura completa. No lo entregues como justificante.</p>}
      <div className="printable">
        <div className="doc">
          {logo && <div className="c"><img src={logo} alt="" style={{ maxWidth: 160, maxHeight: 70, objectFit: 'contain', filter: 'grayscale(1)' }} /></div>}
          <div className="c"><strong>{p.issuer.name}</strong></div>
          {p.issuer.legal_name && <div className="c">{p.issuer.legal_name}</div>}
          {p.issuer.tax_id && <div className="c">NIF {p.issuer.tax_id}</div>}
          {p.issuer.address && <div className="c">{p.issuer.address} {p.issuer.postal_code} {p.issuer.city}</div>}
          <hr />
          <div><strong>{DOC_LABEL[d.type]}</strong> {d.series}-{String(d.number).padStart(5, '0')}</div>
          <div>{dateTime(d.created_at)} · {p.place}</div>
          {p.waiter && <div>Atendido por: {p.waiter}</div>}
          {c && <><hr /><div><strong>Cliente:</strong> {c.name}</div><div>NIF {c.taxId}</div><div>{c.address} {c.postalCode} {c.city}</div></>}
          <hr />
          {p.lines.filter((l: any) => l.unitCents > 0 || !l.name.includes('·')).map((l: any, i: number) => (
            <div key={i} className="l"><span>{l.qty} {l.name}</span><span>{money(l.unitCents * l.qty)}</span></div>
          ))}
          {p.discounts?.map((x: any, i: number) => <div key={`d${i}`} className="l"><span>{x.label}</span><span>-{money(x.amountCents)}</span></div>)}
          {p.loyaltyCustomer && <div>Cliente: {p.loyaltyCustomer}</div>}
          <hr />
          <div className="l"><strong>TOTAL</strong><strong>{money(d.total_cents)}</strong></div>
          {p.vat.map((v: any) => (
            <div key={v.rate} className="l small"><span>IVA {v.rate}% · base {money(v.baseCents)}</span><span>{money(v.vatCents)}</span></div>
          ))}
          {d.type === 'proforma' && <><hr /><div className="c"><strong>DOCUMENTO INFORMATIVO · NO ES JUSTIFICANTE DE PAGO</strong></div></>}
          {d.type !== 'proforma' && p.payments?.length > 0 && <><hr />{p.payments.map((x: any) => <div key={x.id} className="l"><span>{({ cash: 'Efectivo', card: 'Tarjeta', bizum: 'Bizum' } as any)[x.method]}</span><span>{money(x.amountCents)}</span></div>)}</>}
          {qr && <><hr /><div className="c"><strong>¿Necesita factura completa?</strong><br />Escanee el código e indique sus datos<br /><img src={qr} alt="QR para pedir la factura completa" width={120} height={120} /></div></>}
          <hr /><div className="c">Gracias por su visita</div>
        </div>
      </div>
      <div className="row mt">
        <TicketPrinterButton id={d.id} />
        <button className="btn" onClick={() => window.print()}>Imprimir desde el navegador</button>
        {d.type === 'simplified' && d.status === 'valid' && <button className="btn" onClick={() => setConverting(true)}>Factura completa…</button>}
      </div>
      {converting && <FullInvoiceForm documentId={d.id} onClose={() => setConverting(false)} onDone={(newId) => { setConverting(false); setDocId(newId); }} />}
    </Modal>
  );
}

function FullInvoiceForm({ documentId, onClose, onDone }: { documentId: string; onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: '', taxId: '', address: '', postalCode: '', city: '', email: '' });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const save = () => run(async () => {
    const doc = await api(`/api/service/documents/${documentId}/full`, { body: f });
    toast('Factura completa emitida. El ticket queda sustituido.');
    onDone(doc.id);
  });
  return (
    <Modal title="Factura completa" onClose={onClose}>
      <p className="small muted">Revisa los datos fiscales del cliente antes de emitirla. Solo se permite dentro del mismo trimestre de la operación. No generes otra venta para obtener una factura.</p>
      <label>Nombre o razón social<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>NIF / CIF<input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value.toUpperCase().replace(/[\s-]/g, '') })} /></label>
      <label>Dirección<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
      <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 2fr' }}>
        <label>Código postal<input value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} /></label>
        <label>Localidad<input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></label>
      </div>
      <label>Correo (opcional)<input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !f.name || !f.taxId || !f.address} onClick={save}>Emitir factura completa</button>
    </Modal>
  );
}

/** Envía el documento a la impresora de tickets (a través del agente de impresión). */
function TicketPrinterButton({ id }: { id: string }) {
  const { busy, error, run } = useAction();
  const toast = useToast();
  return (
    <>
      <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api(`/api/service/documents/${id}/print`, { body: {} }); toast('Enviado a la impresora de tickets'); })}>Imprimir ticket</button>
      {error && <span className="error small">{error}</span>}
    </>
  );
}
