import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorText, useAction } from '../components/ui';

export default function Login() {
  const { refresh } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => { e.preventDefault(); run(async () => { await api('/api/auth/login', { body: { username, password } }); await refresh(); }); };
  return (
    <div className="center-page">
      <form className="card login" onSubmit={submit}>
        <div style={{ fontWeight: 800, letterSpacing: '.12em', color: 'var(--green)' }}>LORYAND</div>
        <h1>Panel de gestión</h1>
        <label>Usuario<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>Contraseña<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <ErrorText error={error} />
        <button className="btn primary block" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}
