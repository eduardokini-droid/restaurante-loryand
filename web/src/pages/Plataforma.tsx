import { useCallback, useEffect, useState } from 'react';
import { api, setSelectedEstablishment } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorText, useAction, useToast } from '../components/ui';

/** Panel del gestor general de Loryand. */
export default function Plataforma() {
  const { logout } = useSession();
  const [list, setList] = useState<any[]>([]);
  const [f, setF] = useState({ name: '', slug: '', adminName: '', adminUser: '', adminPass: '' });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => { api('/api/platform/establishments').then(setList).catch(() => {}); }, []);
  useEffect(load, [load]);
  const create = () => run(async () => {
    await api('/api/platform/establishments', { body: { name: f.name, slug: f.slug, admin: { name: f.adminName, username: f.adminUser, password: f.adminPass } } });
    toast('Establecimiento creado'); setF({ name: '', slug: '', adminName: '', adminUser: '', adminPass: '' }); load();
  });
  const enter = (id: string) => { setSelectedEstablishment(id); location.assign('/gestion'); };
  const toggle = (e: any) => run(async () => {
    if (e.active && !confirm(`Desactivar «${e.name}» corta el acceso a todo su personal. ¿Continuar?`)) return;
    await api(`/api/platform/establishments/${e.id}`, { method: 'PATCH', body: { active: !e.active } }); load();
  });
  return (
    <div style={{ padding: '1.5rem', maxWidth: 960, margin: '0 auto' }} className="stack">
      <div className="spread"><h1>Gestor general · Establecimientos</h1><button className="btn" onClick={logout}>Salir</button></div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="list">
          <thead><tr><th>Establecimiento</th><th>Identificador</th><th>Mesas activas</th><th></th></tr></thead>
          <tbody>{list.map((e) => (
            <tr key={e.id} style={e.active ? undefined : { opacity: .55 }}>
              <td><strong>{e.name}</strong></td><td><code>{e.slug}</code></td><td>{e.active_tables}</td>
              <td className="right"><button className="btn small primary" onClick={() => enter(e.id)}>Entrar</button> <button className="btn small ghost" onClick={() => toggle(e)}>{e.active ? 'Desactivar' : 'Activar'}</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="card">
        <h3>Nuevo establecimiento</h3>
        <div className="grid cols-2">
          <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: f.slug || '' })} /></label>
          <label>Identificador (para el acceso del personal)<input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></label>
          <label>Nombre del administrador<input value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} /></label>
          <label>Usuario del administrador<input value={f.adminUser} onChange={(e) => setF({ ...f, adminUser: e.target.value })} /></label>
          <label>Contraseña inicial<input type="password" value={f.adminPass} onChange={(e) => setF({ ...f, adminPass: e.target.value })} /></label>
        </div>
        <ErrorText error={error} />
        <button className="btn primary" disabled={busy || !f.name || !f.slug || !f.adminUser || f.adminPass.length < 8} onClick={create}>Crear establecimiento</button>
      </div>
    </div>
  );
}
