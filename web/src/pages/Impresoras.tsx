import { useCallback, useEffect, useState } from 'react';
import { api, getSelectedEstablishment } from '../lib/api';
import { dateTime, time } from '../lib/format';
import { useLive } from '../lib/realtime';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';

const CONN: Record<string, [string, string]> = {
  tcp: ['Red (cable o wifi)', '192.168.1.50'],
  windows: ['USB en Windows (impresora compartida)', 'TICKETS'],
  device: ['USB en Linux / Raspberry Pi', '/dev/usb/lp0'],
  cups: ['macOS / CUPS', 'EPSON_TM_T20II'],
};
const ROLE: Record<string, string> = { kitchen: 'Comandas de cocina', bar: 'Comandas de barra', ticket: 'Tickets y facturas' };
const JOB: Record<string, [string, string]> = { queued: ['En cola', 'warn'], sent: ['Enviado al agente', 'warn'], printed: ['Impreso', ''], failed: ['Error', 'danger'] };

/** Impresoras de tickets y agente de impresión. Solo administrador. */
export default function Impresoras() {
  const [d, setD] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [form, setForm] = useState<any | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => {
    api('/api/printing').then(setD).catch(() => {});
    api('/api/printing/jobs').then(setJobs).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useLive(load, [], { intervalMs: 5000 });
  if (!d) return <p className="muted">Cargando…</p>;

  const online = d.agents.some((a: any) => a.online);
  const newAgent = () => run(async () => { const name = prompt('Nombre del ordenador donde se instalará (p. ej. «PC de barra»)'); if (!name) return; const a = await api('/api/printing/agents', { body: { name } }); setToken(a.token); load(); });
  const download = async (file: string) => {
    const res = await fetch(`/api/printing/agent-files/${file}`, { headers: { 'x-establishment-id': getSelectedEstablishment() ?? '' } });
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = file; a.click();
  };
  const setAuto = (k: string, v: boolean) => run(async () => { await api('/api/printing/settings', { method: 'PUT', body: { ...d.autoPrint, [k]: v } }); load(); });

  return (
    <div className="stack" style={{ maxWidth: 960 }}>
      <h1>Impresoras de tickets</h1>
      <p className="small muted">Impresoras térmicas ESC/POS (Epson TM-T20II y compatibles). El servidor está en internet y no llega a la red del local: por eso un <strong>agente de impresión</strong> instalado en un ordenador del restaurante recoge los trabajos y los envía a las impresoras. Si el agente se apaga, los trabajos esperan en cola.</p>
      <ErrorText error={error} />

      <div className="card">
        <div className="spread"><h3 style={{ margin: 0 }}>1 · Agente de impresión</h3>
          {online ? <span className="badge">Conectado</span> : <span className="badge danger">Sin agente conectado</span>}</div>
        {d.agents.map((a: any) => (
          <div key={a.id} className="spread small" style={{ padding: '.4rem 0' }}>
            <span><strong>{a.name}</strong> · {a.online ? 'conectado' : a.last_seen_at ? `visto por última vez ${dateTime(a.last_seen_at)}` : 'nunca conectado'}{a.version && ` · v${a.version}`}</span>
            <button className="btn small ghost" onClick={() => confirm(`¿Eliminar el agente «${a.name}»? Dejará de imprimir.`) && run(async () => { await api(`/api/printing/agents/${a.id}`, { method: 'DELETE' }); load(); })}>Eliminar</button>
          </div>
        ))}
        <ol className="small">
          <li>Instala <a href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js</a> (versión LTS) en el ordenador del local.</li>
          <li>Descarga a una carpeta: <button className="btn small" onClick={() => download('agente.mjs')}>agente.mjs</button> <button className="btn small" onClick={() => download('iniciar-agente.bat')}>iniciar-agente.bat</button> (Windows) <button className="btn small ghost" onClick={() => download('iniciar-agente.sh')}>iniciar-agente.sh</button> (Mac/Linux) <button className="btn small ghost" onClick={() => download('LEEME.md')}>instrucciones</button></li>
          <li>Crea el agente aquí y copia el token: <button className="btn small primary" disabled={busy} onClick={newAgent}>Nuevo agente</button></li>
          <li>Abre <code>iniciar-agente.bat</code>: pide la dirección del programa (<code>{location.origin}</code>) y el token. Deja la ventana abierta.</li>
        </ol>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="spread"><h3 style={{ margin: 0 }}>2 · Impresoras</h3>
          <button className="btn primary small" onClick={() => setForm({ name: '', connection: 'tcp', address: '', widthChars: 48, roles: ['kitchen'], active: true })}>+ Añadir impresora</button></div>
        {d.printers.length === 0 ? <p className="muted">Todavía no hay impresoras.</p> : (
          <table className="list mt"><thead><tr><th>Impresora</th><th>Conexión</th><th>Imprime</th><th></th></tr></thead>
            <tbody>{d.printers.map((p: any) => (
              <tr key={p.id} style={p.active ? undefined : { opacity: .5 }}>
                <td><strong>{p.name}</strong><div className="small muted">{p.width_chars} columnas ({p.width_chars >= 42 ? '80 mm' : '58 mm'})</div></td>
                <td className="small">{CONN[p.connection][0]}<div><code>{p.address}</code></div></td>
                <td className="small">{p.roles.map((r: string) => ROLE[r]).join(', ') || '—'}</td>
                <td className="right"><div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                  <button className="btn small" disabled={busy} onClick={() => run(async () => { await api(`/api/printing/printers/${p.id}/test`, { body: {} }); toast(online ? 'Prueba enviada' : 'Prueba en cola: se imprimirá cuando el agente se conecte'); load(); })}>Imprimir prueba</button>
                  <button className="btn small ghost" onClick={() => setForm({ id: p.id, name: p.name, connection: p.connection, address: p.address, widthChars: p.width_chars, roles: p.roles, active: p.active })}>Editar</button>
                </div></td>
              </tr>
            ))}</tbody></table>
        )}
      </div>

      <div className="card">
        <h3>3 · Impresión automática</h3>
        <label className="check"><input type="checkbox" checked={d.autoPrint.kitchen} onChange={(e) => setAuto('kitchen', e.target.checked)} /> Imprimir las comandas de cocina al enviarlas</label>
        <label className="check"><input type="checkbox" checked={d.autoPrint.bar} onChange={(e) => setAuto('bar', e.target.checked)} /> Imprimir las comandas de barra al enviarlas</label>
        <label className="check"><input type="checkbox" checked={d.autoPrint.ticket} onChange={(e) => setAuto('ticket', e.target.checked)} /> Imprimir el ticket al cobrar</label>
        <p className="small muted">Los pases en espera se imprimen al pulsar «Marchar». Siempre puedes imprimir a mano desde la cuenta o la pantalla de cocina.</p>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <h3>Últimas impresiones</h3>
        {jobs.length === 0 ? <p className="muted">Nada impreso todavía.</p> : (
          <table className="list"><thead><tr><th>Hora</th><th>Trabajo</th><th>Impresora</th><th>Estado</th><th></th></tr></thead>
            <tbody>{jobs.map((j) => (
              <tr key={j.id}><td className="small">{time(j.created_at)}</td><td className="small">{j.title}</td><td className="small">{j.printer}</td>
                <td><span className={`badge ${JOB[j.status][1]}`}>{JOB[j.status][0]}</span>{j.error && <div className="small" style={{ color: 'var(--danger)' }}>{j.error}</div>}</td>
                <td className="right">{j.status === 'failed' && <button className="btn small" onClick={() => run(async () => { await api(`/api/printing/jobs/${j.id}/retry`, { body: {} }); load(); })}>Reintentar</button>}</td></tr>
            ))}</tbody></table>
        )}
      </div>

      {token && (
        <Modal title="Token del agente" onClose={() => setToken(null)}>
          <p className="notice small">Cópialo ahora: <strong>no se volverá a mostrar</strong>. Quien lo tenga puede recibir los tickets de este local.</p>
          <p><code style={{ wordBreak: 'break-all', fontSize: '1rem' }}>{token}</code></p>
          <button className="btn primary" onClick={() => { navigator.clipboard?.writeText(token); toast('Token copiado'); }}>Copiar token</button>
        </Modal>
      )}
      {form && <PrinterForm initial={form} onClose={() => setForm(null)} onDone={() => { setForm(null); load(); }} />}
    </div>
  );
}

function PrinterForm({ initial, onClose, onDone }: { initial: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState(initial);
  const { busy, error, run } = useAction();
  const save = () => run(async () => {
    const { id, ...body } = f;
    if (id) await api(`/api/printing/printers/${id}`, { method: 'PATCH', body }); else await api('/api/printing/printers', { body });
    onDone();
  });
  const toggle = (r: string) => setF({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x: string) => x !== r) : [...f.roles, r] });
  return (
    <Modal title={f.id ? 'Editar impresora' : 'Añadir impresora'} onClose={onClose}>
      <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Cocina, Barra, Caja…" /></label>
      <label>Conexión<select value={f.connection} onChange={(e) => setF({ ...f, connection: e.target.value })}>{Object.entries(CONN).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label>{f.connection === 'tcp' ? 'IP de la impresora (puerto 9100 por defecto)' : f.connection === 'windows' ? 'Nombre con el que está compartida en Windows' : f.connection === 'device' ? 'Dispositivo' : 'Nombre de la impresora en CUPS'}
        <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value.trim() })} placeholder={CONN[f.connection][1]} /></label>
      {f.connection === 'tcp' && <p className="small muted">La IP aparece en la hoja de estado: apaga la impresora, mantén pulsado FEED y enciéndela.</p>}
      <label>Ancho del papel<select value={f.widthChars} onChange={(e) => setF({ ...f, widthChars: Number(e.target.value) })}><option value={48}>80 mm (48 columnas) · TM-T20II</option><option value={42}>80 mm (42 columnas)</option><option value={32}>58 mm (32 columnas)</option></select></label>
      <div className="stack" style={{ marginBottom: '.75rem' }}>
        {Object.entries(ROLE).map(([k, l]) => <label key={k} className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.roles.includes(k)} onChange={() => toggle(k)} /> {l}</label>)}
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Activa</label>
      </div>
      <ErrorText error={error} />
      <div className="spread">
        {f.id ? <button className="btn danger" disabled={busy} onClick={() => confirm('¿Eliminar esta impresora?') && run(async () => { await api(`/api/printing/printers/${f.id}`, { method: 'DELETE' }); onDone(); })}>Eliminar</button> : <span />}
        <button className="btn primary" disabled={busy || !f.name || !f.address} onClick={save}>Guardar</button>
      </div>
    </Modal>
  );
}
