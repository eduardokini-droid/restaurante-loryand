import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ErrorText, useAction } from '../components/ui';

/** Página del enlace de recuperación: poner una contraseña nueva. */
export default function Recuperar() {
  const { token } = useParams();
  const [info, setInfo] = useState<{ name: string; username: string; totpEnabled: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { api<any>(`/api/auth/reset/${token}`).then(setInfo).catch((e) => setLoadError(e.message)); }, [token]);
  const save = (e: React.FormEvent) => { e.preventDefault(); run(async () => { await api('/api/auth/reset', { body: { token, password: p1 } }); setDone(true); }); };
  return (
    <div className="center-page">
      <form className="card login" onSubmit={save}>
        <div style={{ fontWeight: 800, letterSpacing: '.12em', color: 'var(--green)' }}>LORYAND</div>
        <h1>Nueva contraseña</h1>
        {loadError && <><p className="error">{loadError}</p><Link className="btn block" to="/gestion">Ir al panel</Link></>}
        {!info && !loadError && <p className="muted">Comprobando el enlace…</p>}
        {info && !done && <>
          <p className="small">Hola, <strong>{info.name}</strong> (usuario <code>{info.username}</code>). Elige una contraseña nueva. Al guardarla se cerrarán las sesiones abiertas en otros dispositivos.</p>
          <label>Contraseña nueva (mínimo 8)<input type="password" autoComplete="new-password" autoFocus value={p1} onChange={(e) => setP1(e.target.value)} minLength={8} required /></label>
          <label>Repítela<input type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} required /></label>
          {p2 && p1 !== p2 && <p className="error">No coinciden.</p>}
          <ErrorText error={error} />
          <button className="btn primary block" disabled={busy || p1.length < 8 || p1 !== p2}>{busy ? 'Guardando…' : 'Guardar contraseña'}</button>
        </>}
        {done && <>
          <p className="notice">Contraseña cambiada.{info?.totpEnabled ? ' Al entrar te pediremos también el código de tu aplicación de autenticación.' : ''}</p>
          <Link className="btn primary block" to="/gestion">Entrar al panel</Link>
        </>}
      </form>
    </div>
  );
}
