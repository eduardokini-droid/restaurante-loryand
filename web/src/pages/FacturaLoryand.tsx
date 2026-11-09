import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { money } from '../lib/format';

const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('es-ES');
const qty = (n: number) => String(n).replace('.', ',');

/** Factura de Loryand a un cliente, lista para imprimir o guardar en PDF desde el navegador. */
export default function FacturaLoryand() {
  const { id } = useParams();
  const [i, setI] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api(`/api/platform/invoices/${id}`).then(setI).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p className="error" style={{ padding: '2rem' }}>{err}</p>;
  if (!i) return <p className="muted" style={{ padding: '2rem' }}>Cargando…</p>;
  const is = i.issuer; const c = i.customer;
  const issuerAddr = [is.address, [is.postalCode, is.city].filter(Boolean).join(' '), is.province].filter(Boolean).join(', ');
  return (
    <div style={{ padding: '1rem' }}>
      <div className="row no-print" style={{ maxWidth: 800, margin: '0 auto 1rem' }}>
        <button className="btn ghost small" onClick={() => history.back()}>← Volver</button>
        <button className="btn primary" onClick={() => window.print()}>Imprimir o guardar en PDF</button>
      </div>
      <article className="printable invoice-sheet" style={{ maxWidth: 800, margin: '0 auto', background: '#fff', color: '#1d1d1b', padding: '2.2rem', borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,.08)', fontSize: 14 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', gap: '1.5rem', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 800, letterSpacing: '.12em', color: '#3f5a3c', fontSize: 18 }}>LORYAND</div>
            <div style={{ marginTop: '.4rem', lineHeight: 1.5 }}><strong>{is.name}</strong><br />NIF {is.taxId}<br />{issuerAddr}{is.email && <><br />{is.email}</>}{is.phone && ` · ${is.phone}`}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{i.kind === 'rectifying' ? 'Factura rectificativa' : 'Factura'}</div>
            <div style={{ fontSize: 18, fontFamily: 'ui-monospace, monospace' }}>{i.code}</div>
            <div className="small" style={{ marginTop: '.4rem', lineHeight: 1.5 }}>Fecha: {fmtDate(i.issue_date)}{i.kind === 'invoice' && <><br />Vencimiento: {fmtDate(i.due_date)}</>}</div>
          </div>
        </header>
        <section style={{ marginTop: '1.6rem', padding: '.9rem 1rem', background: '#f6f4ef', borderRadius: 6, lineHeight: 1.5 }}>
          <div className="small" style={{ color: '#6b6b66' }}>Cliente</div>
          <strong>{c.name}</strong> · NIF {c.taxId}<br />{c.address}{c.establishment && c.establishment !== c.name && <><br />Establecimiento: {c.establishment}</>}
        </section>
        {i.rectifies && <p style={{ marginTop: '1rem' }}>Rectifica la factura <strong>{i.rectifies.code}</strong> de {fmtDate(i.rectifies.issueDate)}. Motivo: {i.reason}</p>}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1.4rem' }}>
          <thead><tr style={{ borderBottom: '2px solid #1d1d1b', textAlign: 'left' }}><th style={{ padding: '.4rem 0' }}>Concepto</th><th style={{ textAlign: 'right' }}>Cantidad</th><th style={{ textAlign: 'right' }}>Precio</th><th style={{ textAlign: 'right' }}>IVA</th><th style={{ textAlign: 'right' }}>Importe</th></tr></thead>
          <tbody>{i.lines.map((l: any, k: number) => (
            <tr key={k} style={{ borderBottom: '1px solid #e4e1d8' }}>
              <td style={{ padding: '.5rem 0' }}>{l.description}</td><td style={{ textAlign: 'right' }}>{qty(l.qty)}</td>
              <td style={{ textAlign: 'right' }}>{money(l.unitCents)}</td><td style={{ textAlign: 'right' }}>{qty(l.vatRate)} %</td>
              <td style={{ textAlign: 'right' }}>{money(Math.round(l.qty * l.unitCents))}</td>
            </tr>
          ))}</tbody>
        </table>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <table style={{ minWidth: 280 }}><tbody>
            {i.vatBreakdown.map((v: any) => (
              <tr key={v.rate}><td>Base imponible{i.vatBreakdown.length > 1 ? ` (${qty(v.rate)} %)` : ''}</td><td style={{ textAlign: 'right' }}>{money(v.baseCents)}</td></tr>
            ))}
            {i.vatBreakdown.map((v: any) => (
              <tr key={`v${v.rate}`}><td>IVA {qty(v.rate)} %</td><td style={{ textAlign: 'right' }}>{money(v.vatCents)}</td></tr>
            ))}
            <tr style={{ borderTop: '2px solid #1d1d1b', fontSize: 17 }}><td style={{ paddingTop: '.4rem' }}><strong>Total</strong></td><td style={{ textAlign: 'right', paddingTop: '.4rem' }}><strong>{money(i.total_cents)}</strong></td></tr>
          </tbody></table>
        </div>
        <footer style={{ marginTop: '2rem', fontSize: 12, color: '#55554f', lineHeight: 1.5 }}>
          {i.kind === 'invoice' && i.status === 'paid' && <p><strong>Pagada</strong> el {fmtDate(i.paid_at)}{i.paid_method && ` · ${i.paid_method}`}.</p>}
          {i.kind === 'invoice' && i.status !== 'paid' && is.iban && <p>Forma de pago: transferencia a la cuenta <strong>{is.iban.replace(/(.{4})/g, '$1 ').trim()}</strong> antes del {fmtDate(i.due_date)}, indicando el número de factura.</p>}
          {is.footer && <p>{is.footer}</p>}
        </footer>
      </article>
    </div>
  );
}
