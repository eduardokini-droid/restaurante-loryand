import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { time } from '../lib/format';
import { useLive } from '../lib/realtime';
import { ErrorText, useAction } from '../components/ui';

interface Item {
  id: string; order_id: string; number: number; note: string; source: string; order_created_at: string; place: string; waiter_name: string | null;
  name: string; option: string | null; qty: number; status: string; course: number; sent_at: string | null; status_at: string;
}
interface Board { warnMin: number; lateMin: number; now: string; items: Item[] }

type Col = 'held' | 'new' | 'preparing' | 'ready' | 'done';
const COLUMNS: { key: Col; title: string; empty: string }[] = [
  { key: 'held', title: 'En espera', empty: 'Ningún pase retenido' },
  { key: 'new', title: 'Nuevos', empty: 'Sin pedidos' },
  { key: 'preparing', title: 'Preparando', empty: 'Nada en marcha' },
  { key: 'ready', title: 'Listos', empty: 'Nada esperando' },
  { key: 'done', title: 'Entregados', empty: 'Últimos 30 minutos' },
];
const colOf = (s: string): Col => (s === 'received' || s === 'delivered' ? 'done' : (s as Col));
const NEXT: Partial<Record<string, string>> = { new: 'preparing', preparing: 'ready', ready: 'delivered' };
const ACTION: Partial<Record<Col, string>> = { new: 'Empezar', preparing: 'Listo', ready: 'Entregado' };

interface Card { key: string; col: Col; orderId: string; number: number; place: string; who: string; note: string; since: string; items: Item[] }

/** Pantalla de cocina o barra por columnas, con colores según el tiempo de espera y aviso sonoro. */
export default function Kds({ destination }: { destination: 'kitchen' | 'bar' }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [skew, setSkew] = useState(0); // diferencia entre el reloj de la tablet y el del servidor
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('loryand.kds.sound') === '1'; } catch { return false; } });
  const [, tick] = useState(0);
  const seen = useRef<Set<string> | null>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(() => {
    api<Board>(`/api/kds/${destination}/board`).then((b) => {
      setSkew(new Date(b.now).getTime() - Date.now());
      const fresh = b.items.filter((i) => i.status === 'new').map((i) => i.order_id);
      if (seen.current && sound && fresh.some((o) => !seen.current!.has(o))) beep();
      seen.current = new Set(fresh);
      setBoard(b);
    }).catch(() => {});
  }, [destination, sound]);
  useEffect(load, [load]);
  const connected = useLive(load, ['orders'], { intervalMs: 10000 });
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 20000); return () => clearInterval(t); }, []);

  const set = (ids: string[], status: string) => run(async () => { await api('/api/service/items', { method: 'PATCH', body: { itemIds: ids, status } }); load(); });
  const minutes = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() + skew - new Date(iso).getTime()) / 60000)) : 0);
  const level = (m: number) => (!board ? '' : m >= board.lateMin ? 'late' : m >= board.warnMin ? 'warn' : 'ok');

  const cards = useMemo(() => {
    const map = new Map<string, Card>();
    for (const i of board?.items ?? []) {
      const col = colOf(i.status);
      const key = `${i.order_id}|${col}`;
      // Nuevos y preparando cuentan desde que llegó a cocina; listos desde que se terminó; entregados desde la entrega.
      const since = col === 'new' || col === 'preparing' ? (i.sent_at ?? i.order_created_at) : i.status_at;
      const c = map.get(key) ?? { key, col, orderId: i.order_id, number: i.number, place: i.place, note: i.note, since,
        who: i.waiter_name ?? (i.source === 'client' ? 'Carta del cliente' : 'TPV'), items: [] };
      if (since < c.since) c.since = since;
      c.items.push(i);
      map.set(key, c);
    }
    return [...map.values()];
  }, [board]);
  const active = new Set(cards.filter((c) => c.col === 'new' || c.col === 'preparing').map((c) => c.orderId)).size;
  const toggleSound = (on: boolean) => { setSound(on); try { localStorage.setItem('loryand.kds.sound', on ? '1' : '0'); } catch { /* */ } if (on) beep(); };

  return (
    <div className="stack kds-board-page">
      <div className="spread">
        <div>
          <div className="small" style={{ color: 'var(--terra)', fontWeight: 700, letterSpacing: '.08em' }}>PEDIDOS EN DIRECTO</div>
          <h1 style={{ margin: 0 }}>{destination === 'kitchen' ? 'Pantalla de cocina' : 'Pantalla de barra'}</h1>
        </div>
        <span className="row">
          <span className="small muted"><strong style={{ fontSize: '1.3rem', color: 'var(--terra)' }}>{active}</strong> {active === 1 ? 'pedido activo' : 'pedidos activos'} · se actualiza solo</span>
          {!connected && <span className="badge danger">Sin conexión</span>}
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.target.checked)} /> Sonido</label>
          <button className="btn small" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>Pantalla completa</button>
        </span>
      </div>
      {board && (
        <div className="row small" style={{ gap: '.4rem' }} aria-label="Control de tiempos">
          <strong>Control de tiempos</strong>
          <span className="kds-legend ok">Verde · menos de {board.warnMin} min</span>
          <span className="kds-legend warn">Naranja · desde {board.warnMin} min</span>
          <span className="kds-legend late">Rojo · desde {board.lateMin} min, requiere atención</span>
        </div>
      )}
      <ErrorText error={error} />
      <div className="kds-board">
        {COLUMNS.map((col) => {
          const list = cards.filter((c) => c.col === col.key);
          return (
            <section key={col.key} className={`kds-col kds-col-${col.key}`} aria-label={col.title}>
              <header className="spread"><h2>{col.title}</h2><span className={`kds-count ${col.key === 'new' && list.length ? 'hot' : ''}`}>{list.length}</span></header>
              {list.length === 0 && <div className="kds-empty">{col.empty}</div>}
              {list.map((c) => {
                const m = minutes(c.since);
                const lv = col.key === 'held' || col.key === 'done' ? '' : level(m);
                const next = NEXT[c.items[0].status];
                return (
                  <article key={c.key} className={`kds-card ${lv}`}>
                    <div className="spread">
                      <strong className="kds-place">{c.place}</strong>
                      {col.key === 'held' ? <span className="badge grey">{c.items[0].course}.º pase</span>
                        : <span className={`kds-time ${lv}`}>{col.key === 'done' ? time(c.since) : `${m} min`}</span>}
                    </div>
                    <div className="small muted">Pedido {c.number} · {c.who}</div>
                    {c.note && <div className="kds-note">{c.note}</div>}
                    <ul className="kds-items">
                      {c.items.map((i) => (
                        <li key={i.id}>
                          <button className="kds-item" disabled={busy || !NEXT[i.status]} onClick={() => NEXT[i.status] && set([i.id], NEXT[i.status]!)}
                            title={NEXT[i.status] ? 'Pulsa para pasar solo este plato a la siguiente columna' : undefined}>
                            <span className="kds-qty">{i.qty}</span><span>{i.name}{i.option && <em> · {i.option}</em>}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {col.key === 'held' && <div className="small muted">Se enviará cuando el camarero pulse «Marchar».</div>}
                    {next && <div className="row" style={{ gap: '.3rem' }}>
                      <button className={`btn small ${col.key === 'preparing' ? 'primary' : ''}`} style={{ flex: 1 }} disabled={busy} onClick={() => set(c.items.map((i) => i.id), next)}>{ACTION[col.key]}</button>
                      {col.key !== 'new' && <button className="btn small ghost" disabled={busy} title="Volver a la columna anterior"
                        onClick={() => set(c.items.map((i) => i.id), col.key === 'preparing' ? 'new' : 'preparing')}>↺</button>}
                    </div>}
                    {col.key === 'new' && <button className="btn small ghost block" disabled={busy} onClick={() => run(async () => { await api(`/api/service/orders/${c.orderId}/reprint`, { body: {} }); })}>Reimprimir comanda</button>}
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(.2, ctx.currentTime); g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .5);
    o.start(); o.stop(ctx.currentTime + .5);
  } catch { /* sin audio */ }
}
