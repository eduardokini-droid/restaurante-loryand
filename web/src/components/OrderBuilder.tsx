import { useEffect, useMemo, useState } from 'react';
import { api, newRequestId } from '../lib/api';
import { money, ALLERGENS } from '../lib/format';
import { sendOrder } from '../lib/queue';
import { ErrorText, Modal, useAction, useToast } from './ui';

export interface MenuProduct {
  id: string; name: string; description: string; price_cents: number; destination: 'kitchen' | 'bar';
  course: number; visible: boolean; options: string[]; allergens: string[]; category_id: string | null; subcategory_id: string | null;
}
interface Category { id: string; parent_id: string | null; name: string }
interface Line { key: string; product: MenuProduct; option: string | null; qty: number }

export type OrderTarget = { tableId: string } | { accountId: string } | { barName: string };

const COURSE_LABEL = ['', '1.º pase', '2.º pase', '3.º pase', '4.º pase', '5.º pase'];

export function OrderBuilder({ target, targetLabel, extraBody, onSent }: {
  target: OrderTarget; targetLabel: string; extraBody?: Record<string, unknown>; onSent: (accountId: string | null) => void;
}) {
  const [menu, setMenu] = useState<{ categories: Category[]; products: MenuProduct[]; bestSellers: string[] } | null>(null);
  const [cat, setCat] = useState<string>('best');
  const [sub, setSub] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [choosing, setChoosing] = useState<MenuProduct | null>(null);
  const [note, setNote] = useState('');
  // El identificador se genera al empezar la comanda y se mantiene en los reintentos: así nunca se duplica.
  const [requestId, setRequestId] = useState(newRequestId);
  const { busy, error, run } = useAction();
  const toast = useToast();

  useEffect(() => { api('/api/service/menu').then(setMenu).catch(() => {}); }, []);

  const roots = menu?.categories.filter((c) => !c.parent_id) ?? [];
  const subs = menu?.categories.filter((c) => c.parent_id === cat) ?? [];
  const shown = useMemo(() => {
    if (!menu) return [];
    const q = search.trim().toLowerCase();
    if (q) return menu.products.filter((p) => p.name.toLowerCase().includes(q));
    if (cat === 'best') {
      const best = menu.bestSellers.map((id) => menu.products.find((p) => p.id === id)).filter(Boolean) as MenuProduct[];
      return best.length ? best : menu.products.slice(0, 12);
    }
    return menu.products.filter((p) => p.category_id === cat && (!sub || p.subcategory_id === sub));
  }, [menu, cat, sub, search]);

  const add = (p: MenuProduct, option: string | null) => {
    const key = `${p.id}|${option ?? ''}`;
    setLines((ls) => ls.some((l) => l.key === key) ? ls.map((l) => l.key === key ? { ...l, qty: l.qty + 1 } : l) : [...ls, { key, product: p, option, qty: 1 }]);
  };
  const pick = (p: MenuProduct) => (p.options.length ? setChoosing(p) : add(p, null));
  const setQty = (key: string, qty: number) => setLines((ls) => qty <= 0 ? ls.filter((l) => l.key !== key) : ls.map((l) => l.key === key ? { ...l, qty } : l));
  const total = lines.reduce((s, l) => s + l.product.price_cents * l.qty, 0);
  const courses = [...new Set(lines.map((l) => l.product.course))].sort();

  const send = () => run(async () => {
    const body = {
      clientRequestId: requestId, target, note, ...extraBody,
      items: lines.map((l) => ({ productId: l.product.id, qty: l.qty, option: l.option })),
    };
    const r = await sendOrder(body, targetLabel);
    if (r.status === 'queued') toast('Sin conexión: comanda guardada en este dispositivo. Todavía NO ha llegado a cocina ni a barra.');
    else toast(r.duplicate ? `Este pedido ya estaba registrado (n.º ${r.number}). No se ha duplicado.` : `Pedido n.º ${r.number} enviado`);
    setLines([]); setNote(''); setRequestId(newRequestId());
    onSent(r.status === 'sent' ? r.accountId : null);
  });

  if (!menu) return <p className="muted">Cargando carta…</p>;

  return (
    <div className="builder">
      <div className="stack">
        <input placeholder="Buscar producto…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar producto" />
        {!search && (
          <>
            <div className="chips">
              <button className={`chip ${cat === 'best' ? 'on' : ''}`} onClick={() => { setCat('best'); setSub(null); }}>★ Más vendidos</button>
              {roots.map((c) => <button key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => { setCat(c.id); setSub(null); }}>{c.name}</button>)}
            </div>
            {subs.length > 0 && (
              <div className="chips">
                <button className={`chip ${!sub ? 'on' : ''}`} onClick={() => setSub(null)}>Todo</button>
                {subs.map((s) => <button key={s.id} className={`chip ${sub === s.id ? 'on' : ''}`} onClick={() => setSub(s.id)}>{s.name}</button>)}
              </div>
            )}
          </>
        )}
        <div className="grid tiles">
          {shown.map((p) => (
            <button key={p.id} className="product-btn" onClick={() => pick(p)}>
              <strong>{p.name}</strong>
              <span className="spread small">
                <span>{money(p.price_cents)}</span>
                <span>
                  {!p.visible && <span className="badge grey" title="No aparece en la carta del cliente">oculto</span>}{' '}
                  <span className={`badge ${p.destination === 'bar' ? 'terra' : ''}`}>{p.destination === 'bar' ? 'Barra' : 'Cocina'}</span>
                </span>
              </span>
            </button>
          ))}
          {shown.length === 0 && <p className="muted">No hay productos aquí.</p>}
        </div>
      </div>

      <div className="card stack" style={{ position: 'sticky', top: '1rem' }}>
        <div className="spread"><h3 style={{ margin: 0 }}>Comanda</h3><span className="badge">{targetLabel}</span></div>
        {lines.length === 0 && <p className="muted small">Pulsa un producto para añadirlo.</p>}
        {courses.map((c) => (
          <div key={c}>
            {courses.length > 1 && <div className="small muted" style={{ marginTop: '.4rem' }}>{COURSE_LABEL[c]}{c !== courses[0] && ' · se retiene hasta «Marchar»'}</div>}
            {lines.filter((l) => l.product.course === c).map((l) => (
              <div key={l.key} className="ticket-line">
                <div>
                  <div>{l.product.name}</div>
                  {l.option && <div className="small muted">{l.option}</div>}
                  <div className="small muted">{l.product.destination === 'bar' ? 'Barra' : 'Cocina'} · {money(l.product.price_cents * l.qty)}</div>
                </div>
                <div className="qty">
                  <button onClick={() => setQty(l.key, l.qty - 1)} aria-label="Quitar uno">−</button>
                  <strong>{l.qty}</strong>
                  <button onClick={() => setQty(l.key, l.qty + 1)} aria-label="Añadir uno">+</button>
                </div>
              </div>
            ))}
          </div>
        ))}
        <input placeholder="Nota para cocina/barra (opcional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        <div className="spread"><strong>Total comanda</strong><strong>{money(total)}</strong></div>
        <ErrorText error={error} />
        <button className="btn primary block" disabled={!lines.length || busy} onClick={send}>
          {busy ? 'Enviando…' : 'Enviar comanda'}
        </button>
      </div>

      {choosing && (
        <Modal title={choosing.name} onClose={() => setChoosing(null)}>
          {choosing.allergens.length > 0 && <p className="small muted">Alérgenos: {choosing.allergens.map((a) => ALLERGENS[a] ?? a).join(', ')}</p>}
          <div className="grid tiles">
            {choosing.options.map((o) => (
              <button key={o} className="product-btn" onClick={() => { add(choosing, o); setChoosing(null); }}><strong>{o}</strong></button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
