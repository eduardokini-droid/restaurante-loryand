import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { ErrorText, useAction, useToast } from '../components/ui';

interface Account { username: string; name: string; email: string | null; role: string; totpEnabled: boolean; recoveryCodesLeft: number; mailConfigured: boolean; mfaRequired: boolean }

/** Mi cuenta: correo de recuperación, contraseña y doble verificación. */
export default function Cuenta({ forced = false, onDone }: { forced?: boolean; onDone?: () => void }) {
  const [acc, setAcc] = useState<Account | null>(null);
  const load = useCallback(() => { api<Account>('/api/auth/account').then(setAcc).catch(() => {}); }, []);
  useEffect(load, [load]);
  const [usedRecovery] = useState(() => { try { const v = sessionStorage.getItem('loryand-recovery-used'); sessionStorage.removeItem('loryand-recovery-used'); return !!v; } catch { return false; } });
  if (!acc) return <p className="muted">Cargando…</p>;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>Mi cuenta</h1>
      {forced && <p className="notice">Por seguridad, la cuenta del gestor general necesita la <strong>doble verificación</strong> antes de seguir: contraseña + un código del móvil que cambia cada 30 segundos.</p>}
      {usedRecovery && <p className="notice">Has entrado con un código de emergencia. Te quedan {acc.recoveryCodesLeft}. Si has perdido el móvil, genera códigos nuevos o vuelve a activar la doble verificación con el móvil nuevo.</p>}
      <p className="muted small">Usuario <code>{acc.username}</code> · {acc.name}</p>
      <TwoFactor acc={acc} reload={load} onEnabled={onDone} />
      {!forced && <>
        <EmailCard acc={acc} reload={load} />
        <PasswordCard />
      </>}
    </div>
  );
}

function TwoFactor({ acc, reload, onEnabled }: { acc: Account; reload: () => void; onEnabled?: () => void }) {
  const [pw, setPw] = useState('');
  const [setup, setSetup] = useState<{ secret: string; img: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [action, setAction] = useState<'regen' | 'disable' | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();

  const start = () => run(async () => {
    const r = await api<{ secret: string; otpauth: string }>('/api/auth/2fa/setup', { body: { currentPassword: pw } });
    setSetup({ secret: r.secret, img: await QRCode.toDataURL(r.otpauth, { width: 240, margin: 1 }) }); setPw('');
  });
  const enable = () => run(async () => {
    const r = await api<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', { body: { code } });
    setCodes(r.recoveryCodes); setSetup(null); setCode(''); reload();
  });
  const confirmAction = () => run(async () => {
    if (action === 'regen') {
      const r = await api<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery-codes', { body: { currentPassword: pw, code } });
      setCodes(r.recoveryCodes);
    } else {
      await api('/api/auth/2fa/disable', { body: { currentPassword: pw, code } });
      toast('Doble verificación desactivada');
    }
    setAction(null); setPw(''); setCode(''); reload();
  });

  if (codes) return (
    <div className="card">
      <h3>Guarda tus códigos de emergencia</h3>
      <p className="small">Sirven para entrar si pierdes o cambias de móvil. <strong>Cada uno vale una sola vez</strong> y no se volverán a mostrar. Imprímelos o guárdalos en un sitio seguro, fuera del móvil.</p>
      <div className="recovery-codes" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, max-content)', gap: '.4rem 2rem', fontFamily: 'ui-monospace, monospace', fontSize: '1.15rem', margin: '1rem 0' }}>
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="row">
        <button className="btn" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Copiados'))}>Copiar</button>
        <button className="btn" onClick={() => window.print()}>Imprimir</button>
        <button className="btn primary" onClick={() => { setCodes(null); onEnabled?.(); }}>Ya los he guardado</button>
      </div>
    </div>
  );

  return (
    <div className="card">
      <div className="spread"><h3 style={{ margin: 0 }}>Doble verificación</h3>
        {acc.totpEnabled ? <span className="badge">Activada</span> : <span className="badge grey">Desactivada</span>}</div>
      {!acc.totpEnabled && !setup && <>
        <p className="small">Además de la contraseña, al entrar se pide un código de 6 cifras de una aplicación del móvil (Google Authenticator, Microsoft Authenticator, Authy…). Así, aunque alguien averigüe tu contraseña, no puede entrar.</p>
        <label>Tu contraseña actual<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <ErrorText error={error} />
        <button className="btn primary" disabled={busy || !pw} onClick={start}>Activar doble verificación</button>
      </>}
      {setup && <>
        <ol className="small" style={{ paddingLeft: '1.2rem' }}>
          <li>Instala en el móvil una aplicación de autenticación si no tienes ninguna.</li>
          <li>Pulsa «Añadir cuenta» / «+» y escanea este código.</li>
          <li>Escribe aquí el código de 6 cifras que aparece.</li>
        </ol>
        <img src={setup.img} alt="Código QR para la aplicación de autenticación" width={240} height={240} style={{ display: 'block', background: '#fff', padding: 8, borderRadius: 8 }} />
        <p className="small muted">¿No puedes escanear? Escribe esta clave en la aplicación: <code style={{ wordBreak: 'break-all' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code></p>
        <label>Código de 6 cifras<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          style={{ fontSize: '1.3rem', letterSpacing: '.25em', maxWidth: 200 }} /></label>
        <ErrorText error={error} />
        <div className="row"><button className="btn" onClick={() => setSetup(null)}>Cancelar</button><button className="btn primary" disabled={busy || code.length !== 6} onClick={enable}>Comprobar y activar</button></div>
      </>}
      {acc.totpEnabled && !action && <>
        <p className="small">Al entrar se te pide el código de tu aplicación. Te quedan <strong>{acc.recoveryCodesLeft}</strong> códigos de emergencia.</p>
        <div className="row">
          <button className="btn" onClick={() => setAction('regen')}>Generar códigos de emergencia nuevos</button>
          {!acc.mfaRequired && <button className="btn ghost" onClick={() => setAction('disable')}>Desactivar</button>}
        </div>
      </>}
      {action && <>
        <p className="small">{action === 'regen' ? 'Los códigos anteriores dejarán de valer.' : 'Al entrar ya solo se pedirá la contraseña.'} Confírmalo con tu contraseña y un código de la aplicación.</p>
        <div className="grid cols-2">
          <label>Contraseña actual<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <label>Código de la aplicación<input inputMode="numeric" autoComplete="one-time-code" maxLength={9} value={code} onChange={(e) => setCode(e.target.value.trim())} /></label>
        </div>
        <ErrorText error={error} />
        <div className="row"><button className="btn" onClick={() => { setAction(null); setPw(''); setCode(''); }}>Cancelar</button>
          <button className={`btn ${action === 'disable' ? 'danger' : 'primary'}`} disabled={busy || !pw || code.length < 6} onClick={confirmAction}>{action === 'regen' ? 'Generar' : 'Desactivar'}</button></div>
      </>}
    </div>
  );
}

function EmailCard({ acc, reload }: { acc: Account; reload: () => void }) {
  const [email, setEmail] = useState(acc.email ?? '');
  const [pw, setPw] = useState('');
  const { busy, error, run } = useAction();
  const toast = useToast();
  const save = () => run(async () => { await api('/api/auth/account', { method: 'PATCH', body: { email: email.trim() || null, currentPassword: pw } }); setPw(''); toast('Correo guardado'); reload(); });
  return (
    <div className="card">
      <h3>Correo para recuperar la contraseña</h3>
      <p className="small muted">Si olvidas la contraseña, en la pantalla de entrada podrás pedir un enlace a este correo.{!acc.mailConfigured && ' (El envío de correos aún no está configurado en el servidor: mientras tanto, el enlace te lo genera tu administrador o Loryand.)'}</p>
      <div className="grid cols-2">
        <label>Correo<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nombre@ejemplo.es" /></label>
        <label>Contraseña actual (para confirmar)<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      </div>
      <ErrorText error={error} />
      <button className="btn primary" disabled={busy || !pw || email.trim() === (acc.email ?? '')} onClick={save}>Guardar correo</button>
    </div>
  );
}

function PasswordCard() {
  const [f, setF] = useState({ current: '', p1: '', p2: '' });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const save = () => run(async () => {
    await api('/api/auth/password', { body: { currentPassword: f.current, password: f.p1 } });
    setF({ current: '', p1: '', p2: '' }); toast('Contraseña cambiada. Se han cerrado tus sesiones en otros dispositivos.');
  });
  return (
    <div className="card">
      <h3>Cambiar contraseña</h3>
      <div className="grid cols-2">
        <label>Contraseña actual<input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
        <span />
        <label>Nueva (mínimo 8)<input type="password" autoComplete="new-password" value={f.p1} onChange={(e) => setF({ ...f, p1: e.target.value })} /></label>
        <label>Repítela<input type="password" autoComplete="new-password" value={f.p2} onChange={(e) => setF({ ...f, p2: e.target.value })} /></label>
      </div>
      {f.p2 && f.p1 !== f.p2 && <p className="error">No coinciden.</p>}
      <ErrorText error={error} />
      <button className="btn primary" disabled={busy || !f.current || f.p1.length < 8 || f.p1 !== f.p2} onClick={save}>Cambiar contraseña</button>
    </div>
  );
}
