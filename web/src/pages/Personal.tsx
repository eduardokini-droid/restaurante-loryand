import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { minutesSince, time } from '../lib/format';
import { useLive, useOnline } from '../lib/realtime';
import { discardQueued, flushQueue, onQueueChange, readQueue, type QueuedOrder } from '../lib/queue';
import { ServiceScreen } from '../components/ServiceScreen';
import { Waitlist } from '../components/Waitlist';
import { ErrorText, useAction, useToast } from '../components/ui';

const LAST_SLUG = 'loryand.lastSlug';
const REQ: Record<string, string> = { pay: 'Quiere pagar', waiter: 'Necesita al camarero', other: 'Otra atención' };

export default function Personal() {
  const { me, loading, refresh, logout } = useSession();
  if (loading) return <p className="muted" style={{ padding: '2rem' }}>Cargando…</p>;
  if (!me || me.actor.kind !== 'waiter') return <WaiterLogin onDone={refresh} />;
  return <Pda name={me.actor.name} establishment={me.establishment?.name ?? ''} onShift={!!me.shift} shiftStart={me.shift?.started_at} refresh={refresh} logout={logout} />;
}

function WaiterLogin({ onDone }: { onDone: () => Promise<void> }) {
  const qr = new URLSearchParams(location.search).get('qr');
  const [slug, setSlug] = useState(() => { try { return localStorage.getItem(LAST_SLUG) ?? ''; } catch { return ''; } });
  const [username, setUsername] = useState('camarero-');
  const [pin, setPin] = useState('');
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (qr) run(async () => { await api('/api/auth/waiter', { body: { qrToken: qr } }); history.replaceState(null, '', '/personal'); await onDone(); });
  }, [qr]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api('/api/auth/waiter', { body: { establishment: slug.trim(), username: username.trim().toLowerCase(), pin } });
      try { localStorage.setItem(LAST_SLUG, slug.trim()); } catch { /* */ }
      await onDone();
    });
  };
  return (
    <div className="center-page">
      <form className="card login" onSubmit={submit}>
        <div style={{ fontWeight: 800, letterSpacing: '.12em', color: 'var(--green)' }}>LORYAND</div>
        <h1>Acceso de personal</h1>
        <label>Establecimiento<input value={slug} onChange={(e) => setSlug(e.target.value)} autoCapitalize="none" required /></label>
        <label>Usuario<input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" required /></label>
        <label>PIN<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} required /></label>
        <ErrorText error={error} />
        <button className="btn primary block" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        <p className="small muted mt">También puedes entrar escaneando tu QR personal.</p>
      </form>
    </div>
  );
}

function Pda({ name, establishment, onShift, shiftStart, refresh, logout }: { name: string; establishment: string; onShift: boolean; shiftStart?: string; refresh: () => Promise<void>; logout: () => Promise<void> }) {
  const online = useOnline();
  const [queue, setQueue] = useState<QueuedOrder[]>(readQueue);
  const [requests, setRequests] = useState<any[]>([]);
  const [tab, setTab] = useState<'sala' | 'espera'>('sala');
  const { busy, error, run } = useAction();
  const toast = useToast();
  useEffect(() => onQueueChange(() => setQueue(readQueue())), []);
  const loadReq = useCallback(() => { api('/api/service/requests').then(setRequests).catch(() => {}); }, []);
  useEffect(loadReq, [loadReq]);
  useLive(loadReq, ['requests']);
  // Al recuperar la conexión se reintenta la cola. El identificador de cada pedido impide duplicarlo.
  useEffect(() => { if (online && queue.length) flushQueue().then((n) => n && toast(`${n} comanda(s) pendientes enviadas`)); }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  const shift = (action: 'start' | 'end') => run(async () => { await api(`/api/service/shift/${action}`, { body: {} }); await refresh(); });
  const attend = (id: string) => run(async () => { await api(`/api/service/requests/${id}/attend`, { body: {} }); loadReq(); });

  return (
    <div style={{ paddingBottom: queue.length || !online ? 80 : 0 }}>
      <header style={{ background: 'var(--green)', color: '#fff', padding: '.75rem 1rem' }} className="spread">
        <div><strong>{name}</strong><div className="small" style={{ opacity: .85 }}>{establishment}{onShift && shiftStart ? ` · turno desde ${time(shiftStart)}` : ''}</div></div>
        <div className="row" style={{ gap: '.4rem' }}>
          {onShift
            ? <button className="btn small" disabled={busy} onClick={() => confirm('¿Fichar la salida?') && shift('end')}>Fichar salida</button>
            : null}
          <button className="btn small ghost" style={{ color: '#fff' }} onClick={logout}>Salir</button>
        </div>
      </header>
      <div style={{ padding: '1rem' }} className="stack">
        <ErrorText error={error} />
        {!onShift ? (
          <div className="card stack">
            <h2>Fuera de turno</h2>
            <p className="muted">Ficha la entrada para empezar a tomar comandas.</p>
            <button className="btn primary block" disabled={busy} onClick={() => shift('start')}>Fichar entrada</button>
          </div>
        ) : (
          <>
            {requests.length > 0 && (
              <div className="card stack">
                <h3 style={{ margin: 0 }}>Avisos de clientes</h3>
                {requests.map((r) => (
                  <div key={r.id} className="spread">
                    <span><strong>Mesa {r.table_label}</strong> · {REQ[r.kind]} <span className="muted small">· {minutesSince(r.created_at)} min</span>{r.note && <div className="small">{r.note}</div>}</span>
                    <button className="btn small primary" disabled={busy} onClick={() => attend(r.id)}>Atendido</button>
                  </div>
                ))}
                <p className="small muted" style={{ margin: 0 }}>Con mesas compartidas, otros camareros ven el mismo aviso: avisa de que te encargas tú.</p>
              </div>
            )}
            <div className="chips">
              <button className={`chip ${tab === 'sala' ? 'on' : ''}`} onClick={() => setTab('sala')}>Sala</button>
              <button className={`chip ${tab === 'espera' ? 'on' : ''}`} onClick={() => setTab('espera')}>Lista de espera</button>
            </div>
            {tab === 'sala' ? <ServiceScreen mode="pda" /> : <Waitlist />}
          </>
        )}
      </div>
      {(queue.length > 0 || !online) && (
        <div className="conn">
          {!online && 'Sin conexión. '}
          {queue.length > 0 && <>{queue.length} comanda(s) PENDIENTES DE SINCRONIZAR: aún no han llegado a cocina ni a barra.{' '}
            <button className="btn small" onClick={() => flushQueue()}>Enviar ahora</button>
            {queue.some((q) => q.lastError) && <div className="small">{queue.filter((q) => q.lastError).map((q) => (
              <div key={q.clientRequestId}>{q.label}: {q.lastError} <button className="btn small ghost" style={{ color: '#fff' }} onClick={() => confirm('¿Descartar esta comanda pendiente?') && discardQueued(q.clientRequestId)}>Descartar</button></div>
            ))}</div>}
          </>}
        </div>
      )}
    </div>
  );
}
