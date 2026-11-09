import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorText, useAction } from '../components/ui';

type Step = { kind: 'password' } | { kind: 'code'; challenge: string } | { kind: 'forgot' } | { kind: 'forgot-sent'; mail: boolean };

export default function Login() {
  const { refresh } = useSession();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const { busy, error, setError, run } = useAction();
  const go = (s: Step) => { setError(null); setCode(''); setStep(s); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (step.kind === 'password') {
        const r = await api<{ ok: boolean; needs2fa?: boolean; challenge?: string }>('/api/auth/login', { body: { username, password } });
        if (r.needs2fa && r.challenge) { setPassword(''); go({ kind: 'code', challenge: r.challenge }); return; }
        await refresh();
      } else if (step.kind === 'code') {
        try {
          const r = await api<{ usedRecoveryCode: boolean }>('/api/auth/login/2fa', { body: { challenge: step.challenge, code } });
          if (r.usedRecoveryCode) sessionStorage.setItem('loryand-recovery-used', '1');
          await refresh();
        } catch (err) {
          if ((err as { status?: number }).status === 410) { go({ kind: 'password' }); }
          throw err;
        }
      } else if (step.kind === 'forgot') {
        const r = await api<{ mail: boolean }>('/api/auth/forgot', { body: { login: username } });
        go({ kind: 'forgot-sent', mail: r.mail });
      }
    });
  };

  return (
    <div className="center-page">
      <form className="card login" onSubmit={submit}>
        <div style={{ fontWeight: 800, letterSpacing: '.12em', color: 'var(--green)' }}>LORYAND</div>
        <h1>Panel de gestión</h1>
        {step.kind === 'password' && <>
          <label>Usuario<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
          <label>Contraseña<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <ErrorText error={error} />
          <button className="btn primary block" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
          <button type="button" className="btn ghost small block mt" onClick={() => go({ kind: 'forgot' })}>¿Has olvidado la contraseña?</button>
        </>}
        {step.kind === 'code' && <>
          <p className="small">{recovery ? 'Escribe uno de tus códigos de emergencia (cada uno vale una sola vez).' : 'Abre tu aplicación de autenticación y escribe el código de 6 cifras de Loryand.'}</p>
          <label>{recovery ? 'Código de emergencia' : 'Código de verificación'}
            <input autoFocus autoComplete="one-time-code" inputMode={recovery ? 'text' : 'numeric'} value={code} maxLength={recovery ? 9 : 6}
              placeholder={recovery ? 'XXXX-XXXX' : '123456'} onChange={(e) => setCode(recovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ''))}
              style={{ fontSize: '1.4rem', letterSpacing: '.25em', textAlign: 'center' }} required /></label>
          <ErrorText error={error} />
          <button className="btn primary block" disabled={busy || (recovery ? code.replace('-', '').length !== 8 : code.length !== 6)}>{busy ? 'Comprobando…' : 'Verificar'}</button>
          <button type="button" className="btn ghost small block mt" onClick={() => { setRecovery(!recovery); setCode(''); setError(null); }}>
            {recovery ? 'Usar la aplicación de autenticación' : 'No tengo el móvil: usar un código de emergencia'}</button>
          <button type="button" className="btn ghost small block" onClick={() => go({ kind: 'password' })}>← Volver</button>
        </>}
        {step.kind === 'forgot' && <>
          <p className="small">Escribe tu usuario o tu correo. Si tu cuenta tiene un correo guardado, te enviaremos un enlace para poner una contraseña nueva.</p>
          <label>Usuario o correo<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} /></label>
          <ErrorText error={error} />
          <button className="btn primary block" disabled={busy}>{busy ? 'Enviando…' : 'Enviar enlace'}</button>
          <button type="button" className="btn ghost small block mt" onClick={() => go({ kind: 'password' })}>← Volver</button>
        </>}
        {step.kind === 'forgot-sent' && <>
          {step.mail
            ? <p className="notice">Si el usuario existe y tiene un correo guardado, en unos minutos recibirás un enlace válido durante 60 minutos. Mira también en «Correo no deseado».</p>
            : <p className="notice">Este servidor no envía correos todavía.</p>}
          <p className="small muted">¿No te llega o no tienes correo guardado? Pide al administrador de tu local un enlace para poner una contraseña nueva. Si eres el administrador, pídeselo a Loryand.</p>
          <button type="button" className="btn block" onClick={() => go({ kind: 'password' })}>Volver a entrar</button>
        </>}
      </form>
    </div>
  );
}
