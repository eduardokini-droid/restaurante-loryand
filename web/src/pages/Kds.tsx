import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { minutesSince, time } from '../lib/format';
import { useLive } from '../lib/realtime';
import { ErrorText, useAction } from '../components/ui';

interface Ticket { order_id: string; number: number; created_at: string; note: string; place: string; waiter_name: string | null; source: string;
  items: { id: string; name: string; option: string | null; qty: number; status: string; course: number }[] }

/** Pantalla de cocina o barra. Avisa con sonido de las comandas nuevas. */
export default function Kds({ destination }: { destination: 'kitchen' | 'bar' }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [sound, setSound] = useState(false);
  const [, tick] = useState(0);
  const { busy, error, run } = useAction();
  const load = useCallback(() => {
    api<Ticket[]>(`/api/kds/${destination}`).then((t) => {
      setTickets((prev) => {
        if (sound && t.some((x) => !prev.find((p) => p.order_id === x.order_id))) beep();
        return t;
      });
    }).catch(() => {});
  }, [destination, sound]);
  useEffect(load, [load]);
  const connected = useLive(load, ['orders'], { intervalMs: 10000 });
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t); }, []);

  const set = (ids: string[], status: string) => run(async () => { await api('/api/service/items', { method: 'PATCH', body: { itemIds: ids, status } }); load(); });

  return (
    <div className="stack">
      <div className="spread">
        <h1>{destination === 'kitchen' ? 'Cocina' : 'Barra'}</h1>
        <span className="row">
          {!connected && <span className="badge danger">Sin conexión</span>}
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={sound} onChange={(e) => { setSound(e.target.checked); if (e.target.checked) beep(); }} /> Sonido</label>
        </span>
      </div>
      <ErrorText error={error} />
      {tickets.length === 0 && <p className="muted">No hay comandas pendientes.</p>}
      <div className="kds">
        {tickets.map((t) => {
          const mins = minutesSince(t.created_at);
          const open = t.items.filter((i) => i.status !== 'ready');
          return (
            <div key={t.order_id} className={`ticket ${mins >= 20 ? 'very-late' : mins >= 10 ? 'late' : ''}`}>
              <div className="spread"><strong style={{ fontSize: '1.15rem' }}>{t.place}</strong><span className="badge">{mins} min</span></div>
              <div className="small muted">Pedido {t.number} · {time(t.created_at)} · {t.waiter_name ?? (t.source === 'client' ? 'Carta del cliente' : 'TPV')}</div>
              {t.note && <div className="notice small mt">{t.note}</div>}
              {t.items.map((i) => (
                <div key={i.id} className={`item ${i.status === 'ready' ? 'ready' : ''}`}>
                  <span><strong>{i.qty}×</strong> {i.name}{i.option && <em> · {i.option}</em>}</span>
                  {i.status === 'new' && <button className="btn small" disabled={busy} onClick={() => set([i.id], 'preparing')}>Preparar</button>}
                  {i.status === 'preparing' && <button className="btn small primary" disabled={busy} onClick={() => set([i.id], 'ready')}>Listo</button>}
                  {i.status === 'ready' && <button className="btn small ghost" disabled={busy} onClick={() => set([i.id], 'preparing')} title="Deshacer">↺</button>}
                </div>
              ))}
              {open.length > 0 && <button className="btn primary block mt" disabled={busy} onClick={() => set(open.map((i) => i.id), 'ready')}>Todo listo</button>}
            </div>
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
