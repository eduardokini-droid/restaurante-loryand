import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DOC_LABEL, dateTime, money } from '../lib/format';
import { Modal } from './ui';

export function DocumentPrint({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api(`/api/service/documents/${id}`).then(setD).catch(() => {}); }, [id]);
  if (!d) return null;
  const p = d.payload;
  return (
    <Modal title={DOC_LABEL[d.type]} onClose={onClose}>
      <div className="printable">
        <div className="doc">
          <div className="c"><strong>{p.issuer.name}</strong></div>
          {p.issuer.legal_name && <div className="c">{p.issuer.legal_name}</div>}
          {p.issuer.tax_id && <div className="c">NIF {p.issuer.tax_id}</div>}
          {p.issuer.address && <div className="c">{p.issuer.address} {p.issuer.postal_code} {p.issuer.city}</div>}
          <hr />
          <div><strong>{DOC_LABEL[d.type]}</strong> {d.series}-{String(d.number).padStart(5, '0')}</div>
          <div>{dateTime(d.created_at)} · {p.place}</div>
          {p.waiter && <div>Atendido por: {p.waiter}</div>}
          <hr />
          {p.lines.map((l: any, i: number) => (
            <div key={i} className="l"><span>{l.qty} {l.name}</span><span>{money(l.unitCents * l.qty)}</span></div>
          ))}
          <hr />
          <div className="l"><strong>TOTAL</strong><strong>{money(d.total_cents)}</strong></div>
          {p.vat.map((v: any) => (
            <div key={v.rate} className="l small"><span>IVA {v.rate}% · base {money(v.baseCents)}</span><span>{money(v.vatCents)}</span></div>
          ))}
          {d.type === 'proforma' && <><hr /><div className="c"><strong>DOCUMENTO INFORMATIVO · NO ES JUSTIFICANTE DE PAGO</strong></div></>}
          {d.type !== 'proforma' && p.payments?.length > 0 && <><hr />{p.payments.map((x: any) => <div key={x.id} className="l"><span>{({ cash: 'Efectivo', card: 'Tarjeta', bizum: 'Bizum' } as any)[x.method]}</span><span>{money(x.amountCents)}</span></div>)}</>}
          <hr /><div className="c">Gracias por su visita</div>
        </div>
      </div>
      <button className="btn primary block mt" onClick={() => window.print()}>Imprimir</button>
    </Modal>
  );
}
