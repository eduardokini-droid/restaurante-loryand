import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ErrorText, useAction, useToast } from '../components/ui';

const MODULE_LABEL: Record<string, string> = {
  tpv: 'TPV y sala', kitchen: 'Cocina', bar: 'Barra', cash: 'Ventas y caja', config: 'Configuración y carta',
  tables: 'Mesas y QR', waiters: 'Camareros', users: 'Usuarios y permisos', reservations: 'Reservas', stock: 'Almacén', loyalty: 'Fidelización',
};

export default function Usuarios() {
  const [users, setUsers] = useState<any[]>([]);
  const [f, setF] = useState({ name: '', username: '', password: '', permissions: [] as string[] });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => { api('/api/admin/users').then(setUsers).catch(() => {}); }, []);
  useEffect(load, [load]);
  const toggle = (list: string[], m: string) => list.includes(m) ? list.filter((x) => x !== m) : [...list, m];
  const create = () => run(async () => { await api('/api/admin/users', { body: f }); toast('Acceso creado'); setF({ name: '', username: '', password: '', permissions: [] }); load(); });
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
              <td><strong>{u.name}</strong><div className="small muted">{u.username} · {u.role === 'admin' ? 'Administrador' : 'Secundario'}</div></td>
              <td>{u.role === 'admin' ? <span className="badge">Todos</span> : (
                <div className="row" style={{ gap: '.25rem' }}>{Object.entries(MODULE_LABEL).map(([k, v]) => (
                  <button key={k} className={`chip ${u.permissions.includes(k) ? 'on' : ''}`} style={{ padding: '.2rem .55rem' }} disabled={busy}
                    onClick={() => patch(u, { permissions: toggle(u.permissions, k) })}>{v}</button>
                ))}</div>
              )}</td>
              <td className="right">{u.role !== 'admin' && <div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                <button className="btn small" onClick={() => { const p = prompt('Nueva contraseña (mínimo 8 caracteres)'); if (p) patch(u, { password: p }); }}>Cambiar contraseña</button>
                <button className="btn small ghost" onClick={() => patch(u, { active: !u.active })}>{u.active ? 'Desactivar' : 'Activar'}</button>
              </div>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
