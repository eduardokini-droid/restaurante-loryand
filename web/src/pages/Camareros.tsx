import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { time } from '../lib/format';
import { useSession } from '../lib/session';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';

interface Waiter { id: string; code: number; name: string; active: boolean; qr_token: string; username: string; table_ids: string[]; shift_started_at: string | null }

export default function Camareros() {
  const { me, refresh } = useSession();
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  const [tables, setTables] = useState<{ id: string; label: string }[]>([]);
  const [shared, setShared] = useState<boolean>(me?.establishment?.settings?.sharedTables ?? true);
  const [form, setForm] = useState({ name: '', pin: '' });
  const [qr, setQr] = useState<Waiter | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => {
    api('/api/admin/waiters').then(setWaiters).catch(() => {});
    api('/api/admin/tables').then(setTables).catch(() => {});
    api('/api/admin/establishment').then((e) => setShared(e.settings.sharedTables)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const create = () => run(async () => { const w = await api('/api/admin/waiters', { body: form }); toast(`Creado ${w.username}`); setForm({ name: '', pin: '' }); load(); });
  const patch = (w: Waiter, body: object, msg?: string) => run(async () => { await api(`/api/admin/waiters/${w.id}`, { method: 'PATCH', body }); if (msg) toast(msg); load(); });
  const toggleShared = (v: boolean) => run(async () => { await api('/api/admin/establishment', { method: 'PUT', body: { settings: { sharedTables: v } } }); setShared(v); refresh(); toast('Guardado'); });

  return (
    <div className="stack">
      <h1>Camareros y claves</h1>
      <div className="card">
        <label className="check"><input type="checkbox" checked={shared} disabled={busy} onChange={(e) => toggleShared(e.target.checked)} /> <strong>Mesas compartidas entre camareros</strong></label>
        <p className="small muted" style={{ margin: 0 }}>Activado: todos atienden todas las mesas y reciben sus avisos. Desactivado: cada camarero solo ve sus mesas asignadas (asignación exclusiva).</p>
      </div>
      <div className="card row">
        <input style={{ maxWidth: 220 }} placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input style={{ maxWidth: 160 }} placeholder="PIN (4 a 6 cifras)" inputMode="numeric" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
        <button className="btn primary" disabled={busy || !form.name || form.pin.length < 4} onClick={create}>Crear camarero</button>
      </div>
      <ErrorText error={error} />
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="list">
          <thead><tr><th>Camarero</th><th>Usuario</th><th>Turno</th>{!shared && <th>Mesas asignadas</th>}<th></th></tr></thead>
          <tbody>
            {waiters.map((w) => (
              <tr key={w.id} style={w.active ? undefined : { opacity: .55 }}>
                <td><strong>{w.name}</strong>{!w.active && <div className="badge grey">Desactivado</div>}</td>
                <td><code>{w.username}</code></td>
                <td>{w.shift_started_at ? <span className="badge">Desde {time(w.shift_started_at)}</span> : <span className="muted small">Fuera de turno</span>}</td>
                {!shared && (
                  <td><div className="row" style={{ gap: '.25rem' }}>
                    {tables.map((t) => {
                      const on = w.table_ids.includes(t.id);
                      return <button key={t.id} className={`chip ${on ? 'on' : ''}`} style={{ padding: '.2rem .55rem' }} disabled={busy}
                        onClick={() => patch(w, { tableIds: on ? w.table_ids.filter((x) => x !== t.id) : [...w.table_ids, t.id] })}>{t.label}</button>;
                    })}
                  </div></td>
                )}
                <td className="right"><div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                  <button className="btn small" onClick={() => setQr(w)}>QR de acceso</button>
                  <button className="btn small" disabled={busy} onClick={() => { const pin = prompt('Nuevo PIN (4 a 6 cifras)'); if (pin) patch(w, { pin }, 'PIN cambiado'); }}>Cambiar clave</button>
                  <button className="btn small ghost" disabled={busy} onClick={() => patch(w, { active: !w.active })}>{w.active ? 'Desactivar' : 'Activar'}</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {qr && <WaiterQr w={qr} slug={me?.establishment?.slug ?? ''} onClose={() => setQr(null)} onRegenerate={() => { patch(qr, { regenerateQr: true }, 'QR renovado: el anterior ya no sirve'); setQr(null); }} />}
    </div>
  );
}

function WaiterQr({ w, slug, onClose, onRegenerate }: { w: Waiter; slug: string; onClose: () => void; onRegenerate: () => void }) {
  const url = `${location.origin}/personal?qr=${w.qr_token}`;
  const [img, setImg] = useState('');
  useEffect(() => { QRCode.toDataURL(url, { width: 320, margin: 1 }).then(setImg); }, [url]);
  return (
    <Modal title={`Acceso de ${w.name}`} onClose={onClose}>
      <p className="small">Local: <code>{slug}</code> · Usuario: <code>{w.username}</code></p>
      {img && <img src={img} alt="QR personal" style={{ width: 240, display: 'block', margin: '0 auto' }} />}
      <p className="notice small">Este QR identifica al camarero, pero para entrar siempre pide su PIN. Para el día a día es más cómodo «Acceso camareros» en el TPV: un código de un solo uso que caduca en 2 minutos.</p>
      <div className="row mt">
        <button className="btn" onClick={() => navigator.clipboard?.writeText(url)}>Copiar enlace</button>
        {img && <a className="btn" href={img} download={`acceso-${w.username}.png`}>Descargar QR</a>}
        <button className="btn danger" onClick={onRegenerate}>Renovar QR</button>
      </div>
    </Modal>
  );
}
