import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DOC_LABEL, METHOD_LABEL, dateTime, money, today } from '../lib/format';
import { DocumentPrint } from '../components/DocumentPrint';
import { ErrorText, useAction } from '../components/ui';

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function Caja() {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [rep, setRep] = useState<any>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [docType, setDocType] = useState('');
  const [doc, setDoc] = useState<string | null>(null);
  const { error, run } = useAction();
  const load = useCallback((f = from, t = to) => run(async () => {
    setRep(await api(`/api/reports/cash?from=${f}&to=${t}`));
    setDocs(await api(`/api/reports/documents?from=${f}&to=${t}${docType ? `&type=${docType}` : ''}`));
  }), [from, to, docType, run]);
  useEffect(() => { load(); }, [docType]); // eslint-disable-line react-hooks/exhaustive-deps
  const preset = (days: number | 'month' | 'week') => {
    const now = new Date(); let start = new Date(now);
    if (days === 'month') start = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (days === 'week') start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    else start.setDate(now.getDate() - days);
    setFrom(iso(start)); setTo(iso(now)); load(iso(start), iso(now));
  };

  return (
    <div className="stack">
      <h1>Ventas y caja</h1>
      <div className="card row">
        <label style={{ margin: 0 }}>Desde<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ margin: 0 }}>Hasta<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn primary" onClick={() => load()}>Consultar</button>
        <button className="btn small" onClick={() => preset(0)}>Hoy</button>
        <button className="btn small" onClick={() => preset('week')}>Esta semana</button>
        <button className="btn small" onClick={() => preset('month')}>Este mes</button>
        <button className="btn small" onClick={() => preset(45)}>45 días</button>
      </div>
      <ErrorText error={error} />
      {rep && (
        <div className="printable stack">
          <div className="grid cols-2">
            <div className="card"><div className="muted small">Total cobrado</div><h2>{money(rep.totalCents)}</h2>
              {rep.byMethod.map((m: any) => <div key={m.method} className="spread small"><span>{METHOD_LABEL[m.method]} ({m.count})</span><strong>{money(m.total_cents)}</strong></div>)}
            </div>
            <div className="card"><div className="muted small">Pendiente de cobro (cuentas abiertas ahora)</div><h2 style={{ color: rep.pendingCents ? 'var(--terra)' : undefined }}>{money(rep.pendingCents)}</h2>
              {rep.pending.map((p: any) => <div key={p.id} className="spread small"><span>{p.place}</span><span>{money(p.pending_cents)}</span></div>)}
            </div>
            <div className="card"><div className="muted small">Cobros por empleado</div>
              {rep.byWaiter.map((w: any) => <div key={w.name} className="spread small"><span>{w.name} ({w.count})</span><strong>{money(w.total_cents)}</strong></div>)}
            </div>
            <div className="card"><div className="muted small">Documentos emitidos</div>
              {rep.documents.map((d: any) => <div key={d.type} className="spread small"><span>{DOC_LABEL[d.type]} ({d.count})</span><span>{money(d.total_cents)}</span></div>)}
            </div>
          </div>
          <p className="small muted">El cierre es un control del programa: compara el efectivo físico con el registro y contrasta tarjeta y Bizum con los justificantes del datáfono y del banco.</p>
          <button className="btn" onClick={() => window.print()}>Imprimir cierre</button>
        </div>
      )}
      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="spread"><h3 style={{ margin: 0 }}>Registro documental</h3>
          <select style={{ maxWidth: 220 }} value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="">Todos los tipos</option>{Object.entries(DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <table className="list mt">
          <thead><tr><th>Número</th><th>Tipo</th><th>Fecha</th><th>Lugar</th><th>Camarero</th><th className="right">Total</th></tr></thead>
          <tbody>{docs.map((d) => (
            <tr key={d.id} onClick={() => setDoc(d.id)} style={{ cursor: 'pointer' }}>
              <td>{d.series}-{String(d.number).padStart(5, '0')}</td><td>{DOC_LABEL[d.type]}</td><td>{dateTime(d.created_at)}</td>
              <td>{d.place}</td><td>{d.waiter ?? '—'}</td><td className="right">{money(d.total_cents)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {doc && <DocumentPrint id={doc} onClose={() => setDoc(null)} />}
    </div>
  );
}
