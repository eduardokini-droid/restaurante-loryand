import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';
import { useSession } from '../lib/session';

const MODULE_LABEL: Record<string, string> = {
  tpv: 'TPV y sala', kitchen: 'Cocina', bar: 'Barra', cash: 'Ventas y caja', config: 'Configuración y carta',
  tables: 'Mesas y QR', waiters: 'Camareros', users: 'Usuarios y permisos', reservations: 'Reservas', stock: 'Almacén', loyalty: 'Fidelización',
};

export default function Usuarios() {
  const [users, setUsers] = useState<any[]>([]);
  const [f, setF] = useState({ name: '', username: '', password: '', email: '', permissions: [] as string[] });
  const [link, setLink] = useState<{ user: any; url: string; expiresAt: string } | null>(null);
  const { me } = useSession();
  const isSuper = me?.actor.role === 'superadmin';
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => { api('/api/admin/users').then(setUsers).catch(() => {}); }, []);
  useEffect(load, [load]);
  const toggle = (list: string[], m: string) => list.includes(m) ? list.filter((x) => x !== m) : [...list, m];
  const create = () => run(async () => { await api('/api/admin/users', { body: { ...f, email: f.email.trim() || undefined } }); toast('Acceso creado'); setF({ name: '', username: '', password: '', email: '', permissions: [] }); load(); });
  const resetLink = (u: any) => run(async () => { const r = await api<{ url: string; expiresAt: string }>(`/api/admin/users/${u.id}/reset-link`, { body: {} }); setLink({ user: u, ...r }); });
  const reset2fa = (u: any) => run(async () => {
    if (!confirm(`¿Quitar la doble verificación de ${u.name}? Úsalo si ha perdido el móvil. Podrá entrar solo con su contraseña y volver a activarla.`)) return;
    await api(`/api/admin/users/${u.id}/reset-2fa`, { body: {} }); toast('Doble verificación quitada'); load();
  });
  const editEmail = (u: any) => { const e = prompt(`Correo de ${u.name} para recuperar la contraseña (vacío para quitarlo)`, u.email ?? ''); if (e != null) patch(u, { email: e.trim() || null }); };
  const patch = (u: any, body: object) => run(async () => { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); toast('Guardado. Se aplica cuando vuelva a entrar.'); load(); });

  return (
    <div className="stack">
      <h1>Usuarios y permisos</h1>
      <p className="muted small">Accesos al panel para encargados o pantallas fijas (por ejemplo, la tablet de cocina). Los camareros se crean en «Camareros».</p>
      <div className="card">
        <div className="grid cols-2">
          <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>Usuario<input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></label>
          <label>Contraseña (mínimo 8)<input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
          <label>Correo (opcional, para recuperar la contraseña)<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        </div>
        <div className="row">{Object.entries(MODULE_LABEL).map(([k, v]) => (
          <label key={k} className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.permissions.includes(k)} onChange={() => setF({ ...f, permissions: toggle(f.permissions, k) })} /> {v}</label>
        ))}</div>
        <ErrorText error={error} />
        <button className="btn primary mt" disabled={busy || !f.name || !f.username || f.password.length < 8} onClick={create}>Crear acceso</button>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="list">
          <thead><tr><th>Usuario</th><th>Permisos</th><th></th></tr></thead>
          <tbody>{users.map((u) => (
            <tr key={u.id} style={u.active ? undefined : { opacity: .55 }}>
              <td style={{ minWidth: 190 }}><strong>{u.name}</strong><div className="small muted">{u.username} · {u.role === 'admin' ? 'Administrador' : 'Secundario'}{u.email ? ` · ${u.email}` : ''}</div>
                {u.totp_enabled && <span className="badge" style={{ marginTop: '.25rem' }}>Doble verificación</span>}</td>
              <td>{u.role === 'admin' ? <span className="badge">Todos</span> : (
                <div className="row" style={{ gap: '.25rem' }}>{Object.entries(MODULE_LABEL).map(([k, v]) => (
                  <button key={k} className={`chip ${u.permissions.includes(k) ? 'on' : ''}`} style={{ padding: '.2rem .55rem' }} disabled={busy}
                    onClick={() => patch(u, { permissions: toggle(u.permissions, k) })}>{v}</button>
                ))}</div>
              )}</td>
              <td className="right">{(u.role !== 'admin' || isSuper) && <div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                <button className="btn small" disabled={!u.active} onClick={() => resetLink(u)}>Enlace para nueva contraseña</button>
                <button className="btn small" onClick={() => editEmail(u)}>Correo</button>
                {u.totp_enabled && <button className="btn small" onClick={() => reset2fa(u)}>Quitar doble verificación</button>}
                {u.role !== 'admin' && <button className="btn small ghost" onClick={() => patch(u, { active: !u.active })}>{u.active ? 'Desactivar' : 'Activar'}</button>}
              </div>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {link && (
        <Modal title={`Enlace para ${link.user.name}`} onClose={() => setLink(null)}>
          <p className="small">Envíaselo a <strong>{link.user.name}</strong> por un canal de confianza. Con él pone su propia contraseña nueva: tú no la llegas a ver. Vale <strong>una sola vez</strong> hasta el {new Date(link.expiresAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}.</p>
          <input readOnly value={link.url} onFocus={(e) => e.target.select()} style={{ fontFamily: 'ui-monospace, monospace', fontSize: '.8rem' }} />
          <div className="row mt">
            <button className="btn" onClick={() => navigator.clipboard?.writeText(link.url).then(() => toast('Enlace copiado'))}>Copiar</button>
            <a className="btn" target="_blank" rel="noreferrer" href={`https://wa.me/?text=${encodeURIComponent(`Hola ${link.user.name}, con este enlace puedes poner tu contraseña nueva del panel de Loryand (un solo uso): ${link.url}`)}`}>Enviar por WhatsApp</a>
            <button className="btn primary" onClick={() => setLink(null)}>Hecho</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
