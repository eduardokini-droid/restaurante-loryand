import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { useSession } from '../lib/session';
import { ErrorText, useAction, useToast } from '../components/ui';
import { WhatsAppPrompt, type MessageResult } from '../components/WhatsAppPrompt';

const EVENT: Record<string, string> = { reservation_confirmed: 'Reserva confirmada', reservation_reminder: 'Recordatorio', waitlist_ready: 'Mesa lista', test: 'Prueba' };

/** Configuración de pagos online (Redsys) y avisos por WhatsApp. Solo administrador. */
export default function Integraciones() {
  const { refresh, me } = useSession();
  const included = me?.establishment?.features?.includes('online') ?? true;
  const [data, setData] = useState<any>(null);
  const [log, setLog] = useState<any[]>([]);
  const load = useCallback(() => {
    api('/api/integrations').then(setData).catch(() => {});
    api('/api/messages').then(setLog).catch(() => {});
  }, []);
  useEffect(load, [load]);
  if (!data) return <p className="muted">Cargando…</p>;
  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <h1>Pagos online y WhatsApp</h1>
      {!included && <p className="notice">El cobro online y los avisos por WhatsApp no están incluidos en el plan de este local: puedes dejarlos configurados, pero no funcionarán hasta que se contraten.</p>}
      <Redsys initial={data.redsys} notifyUrl={data.notifyUrl} onSaved={() => { load(); refresh(); }} />
      <WhatsApp initial={data.whatsapp} onSaved={load} />
      <div className="card" style={{ overflowX: 'auto' }}>
        <h3>Últimos avisos</h3>
        {log.length === 0 ? <p className="muted">Todavía no se ha enviado ningún aviso.</p> : (
          <table className="list"><thead><tr><th>Fecha</th><th>Aviso</th><th>Cliente</th><th>Teléfono</th><th>Estado</th></tr></thead>
            <tbody>{log.map((m) => (
              <tr key={m.id}><td className="small">{dateTime(m.created_at)}</td><td>{EVENT[m.event]}</td><td>{m.customer ?? '—'}</td><td className="small">+{m.to_phone}</td>
                <td>{m.status === 'sent' ? <span className="badge">Enviado</span> : m.status === 'manual' ? <span className="badge grey">Preparado (envío a mano)</span> : <span className="badge danger" title={m.error}>Fallido</span>}</td></tr>
            ))}</tbody></table>
        )}
      </div>
    </div>
  );
}

function Redsys({ initial, notifyUrl, onSaved }: { initial: any; notifyUrl: string; onSaved: () => void }) {
  const [f, setF] = useState({ ...initial.config, enabled: initial.enabled, secret: '' });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const save = () => run(async () => {
    if (f.environment === 'live' && f.enabled && !confirm('Vas a activar el entorno REAL: los pagos cobrarán dinero. ¿Lo has probado antes en el entorno de pruebas?')) return;
    const { secret, ...rest } = f;
    await api('/api/integrations/redsys', { method: 'PUT', body: { ...rest, ...(secret ? { secret } : {}) } });
    toast('Configuración de pagos guardada'); setF({ ...f, secret: '' }); onSaved();
  });
  const useTestData = () => setF({ ...f, merchantCode: '999008881', terminal: '001', environment: 'test', secret: 'sq7HjrUOBfKmC576ILgskD5srU870gJ7' });
  return (
    <div className="card">
      <div className="spread"><h3 style={{ margin: 0 }}>Cobros online · Redsys (tarjeta y Bizum)</h3>
        {initial.enabled ? <span className={`badge ${initial.config.environment === 'live' ? '' : 'warn'}`}>{initial.config.environment === 'live' ? 'Activo · real' : 'Activo · pruebas'}</span> : <span className="badge grey">Desactivado</span>}</div>
      <p className="small muted">Necesitas el TPV virtual de tu banco (Redsys). Los datos están en el panel de Redsys o te los da el banco. Bizum requiere contratarlo y activarlo con el banco.</p>
      <div className="grid cols-2">
        <label>Código de comercio (FUC)<input value={f.merchantCode} onChange={(e) => setF({ ...f, merchantCode: e.target.value.trim() })} /></label>
        <label>Terminal<input value={f.terminal} onChange={(e) => setF({ ...f, terminal: e.target.value.trim() })} /></label>
        <label>Clave de firma SHA-256 {initial.secret && <span className="muted">(guardada: {initial.secret})</span>}
          <input type="password" autoComplete="off" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value.trim() })} placeholder={initial.secret ? 'Déjala vacía para no cambiarla' : '32 caracteres'} /></label>
        <label>Entorno<select value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}><option value="test">Pruebas (no cobra)</option><option value="live">Real</option></select></label>
      </div>
      <div className="row">
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.card} onChange={(e) => setF({ ...f, card: e.target.checked })} /> Tarjeta</label>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.bizum} onChange={(e) => setF({ ...f, bizum: e.target.checked })} /> Bizum</label>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> <strong>Habilitar cobro online</strong></label>
      </div>
      <p className="small muted mt">URL de notificación (Redsys la usa para confirmar cada pago): <code style={{ wordBreak: 'break-all' }}>{notifyUrl}</code></p>
      <ErrorText error={error} />
      <div className="row mt">
        <button className="btn primary" disabled={busy} onClick={save}>Guardar</button>
        <button className="btn small ghost" onClick={useTestData}>Rellenar con los datos públicos de pruebas de Redsys</button>
      </div>
    </div>
  );
}

function WhatsApp({ initial, onSaved }: { initial: any; onSaved: () => void }) {
  const [f, setF] = useState({ ...initial.config, enabled: initial.enabled, token: '' });
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState<MessageResult | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const setEv = (k: string, v: unknown) => setF({ ...f, events: { ...f.events, [k]: v } });
  const setTpl = (k: string, v: string) => setF({ ...f, templates: { ...f.templates, [k]: v } });
  const save = () => run(async () => {
    const { token, ...rest } = f;
    await api('/api/integrations/whatsapp', { method: 'PUT', body: { ...rest, ...(token ? { token } : {}) } });
    toast('Configuración de WhatsApp guardada'); setF({ ...f, token: '' }); onSaved();
  });
  const test = () => run(async () => {
    const r = await api('/api/integrations/whatsapp/test', { body: { phone } });
    if (r.status === 'sent') toast('Mensaje de prueba enviado'); else setResult(r);
    onSaved();
  });
  return (
    <div className="card">
      <div className="spread"><h3 style={{ margin: 0 }}>Avisos por WhatsApp</h3>{initial.enabled ? <span className="badge">Activos</span> : <span className="badge grey">Desactivados</span>}</div>
      <div className="row" style={{ margin: '.75rem 0' }}>
        <button className={`chip ${f.provider === 'link' ? 'on' : ''}`} onClick={() => setF({ ...f, provider: 'link' })}>Modo enlace (gratis)</button>
        <button className={`chip ${f.provider === 'meta' ? 'on' : ''}`} onClick={() => setF({ ...f, provider: 'meta' })}>Envío automático (WhatsApp Business)</button>
      </div>
      {f.provider === 'link' ? (
        <p className="small muted">El programa prepara el mensaje y abre WhatsApp en el teléfono del personal con el texto escrito; solo hay que pulsar enviar. No requiere alta ni coste. Los recordatorios automáticos no están disponibles en este modo.</p>
      ) : (
        <>
          <p className="small muted">Requiere una cuenta de WhatsApp Business Platform (Meta) con un número verificado y estas plantillas aprobadas, en este orden de variables:
            <br />· Reserva confirmada: {'{{1}}'} nombre, {'{{2}}'} local, {'{{3}}'} personas, {'{{4}}'} fecha, {'{{5}}'} hora
            <br />· Recordatorio: {'{{1}}'} nombre, {'{{2}}'} local, {'{{3}}'} fecha, {'{{4}}'} hora, {'{{5}}'} personas
            <br />· Mesa lista: {'{{1}}'} nombre, {'{{2}}'} local, {'{{3}}'} mesa</p>
          <div className="grid cols-2">
            <label>Identificador del número de teléfono<input value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value.trim() })} /></label>
            <label>Token de acceso {initial.secret && <span className="muted">(guardado: {initial.secret})</span>}
              <input type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value.trim() })} placeholder={initial.secret ? 'Déjalo vacío para no cambiarlo' : ''} /></label>
            <label>Plantilla «reserva confirmada»<input value={f.templates.reservation_confirmed} onChange={(e) => setTpl('reservation_confirmed', e.target.value)} /></label>
            <label>Plantilla «recordatorio»<input value={f.templates.reservation_reminder} onChange={(e) => setTpl('reservation_reminder', e.target.value)} /></label>
            <label>Plantilla «mesa lista»<input value={f.templates.waitlist_ready} onChange={(e) => setTpl('waitlist_ready', e.target.value)} /></label>
            <label>Idioma de las plantillas<input value={f.language} onChange={(e) => setF({ ...f, language: e.target.value.trim() })} /></label>
          </div>
        </>
      )}
      <div className="stack">
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.events.reservationConfirmed} onChange={(e) => setEv('reservationConfirmed', e.target.checked)} /> Avisar al confirmar una reserva</label>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.events.waitlistReady} onChange={(e) => setEv('waitlistReady', e.target.checked)} /> Avisar al grupo de la lista de espera cuando su mesa esté lista</label>
        {f.provider === 'meta' && (
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.events.reservationReminder} onChange={(e) => setEv('reservationReminder', e.target.checked)} /> Recordatorio
            <input type="number" min={1} max={48} style={{ width: 70 }} value={f.events.reminderHours} onChange={(e) => setEv('reminderHours', Number(e.target.value))} /> horas antes</label>
        )}
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> <strong>Activar avisos por WhatsApp</strong></label>
      </div>
      <ErrorText error={error} />
      <div className="row mt">
        <button className="btn primary" disabled={busy} onClick={save}>Guardar</button>
        <input style={{ maxWidth: 180 }} placeholder="Tu móvil para probar" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="btn" disabled={busy || phone.length < 6} onClick={test}>Enviar prueba</button>
      </div>
      <WhatsAppPrompt result={result} onClose={() => setResult(null)} />
    </div>
  );
}
