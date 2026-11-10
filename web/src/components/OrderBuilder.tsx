import { useEffect, useMemo, useState } from 'react';
import { api, newRequestId } from '../lib/api';
import { money, ALLERGENS } from '../lib/format';
import { sendOrder } from '../lib/queue';
import { ErrorText, Modal, useAction, useToast } from './ui';
import { t, type Lang } from '../lib/i18n';
import { DocumentPrint } from './DocumentPrint';

export interface MenuProduct {
  id: string; name: string; description: string; price_cents: number; destination: 'kitchen' | 'bar';
  course: number; visible: boolean; options: string[]; allergens: string[]; category_id: string | null; subcategory_id: string | null; photo_url?: string | null;
}
interface Category { id: string; parent_id: string | null; name: string }
interface Line { key: string; product: MenuProduct; option: string | null; qty: number; menu?: Record<string, string> }
export interface DailyMenu { name: string; price_cents: number; sections: Record<string, string[]> }
export const MENU_SECTIONS: [string, string][] = [['first', 'Primero'], ['second', 'Segundo'], ['dessert', 'Postre'], ['drink', 'Bebida'], ['coffee', 'Café']];

export type OrderTarget = { tableId: string } | { accountId: string } | { barName: string };

const COURSE_LABEL = ['', '1.º pase', '2.º pase', '3.º pase', '4.º pase', '5.º pase'];

export function OrderBuilder({ target, targetLabel, extraBody, onSent, quick = false }: {
  target: OrderTarget; targetLabel: string; extraBody?: Record<string, unknown>; onSent: (accountId: string | null) => void;
  /** Venta rápida: se cobra al momento, sin mesa ni cuenta abierta. */
  quick?: boolean;
}) {
  const [menu, setMenu] = useState<{ categories: Category[]; products: MenuProduct[]; bestSellers: string[]; dailyMenu: DailyMenu | null } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cat, setCat] = useState<string>('best');
  const [sub, setSub] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [choosing, setChoosing] = useState<MenuProduct | null>(null);
  const [note, setNote] = useState('');
  // El identificador se genera al empezar la comanda y se mantiene en los reintentos: así nunca se duplica.
  const [requestId, setRequestId] = useState(newRequestId);
  const [method, setMethod] = useState<'cash' | 'card' | 'bizum'>('cash');
  const [tendered, setTendered] = useState('');
  const [sold, setSold] = useState<{ total: number; change: number | null; documentId: string | null; number: number } | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
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
  const addMenu = (choice: Record<string, string>) => {
    const dm = menu!.dailyMenu!;
    // Cada menú es una línea propia: cada persona elige sus platos.
    const product: MenuProduct = { id: 'menu', name: dm.name, description: '', price_cents: dm.price_cents, destination: 'kitchen', course: 1, visible: true, options: [], allergens: [], category_id: null, subcategory_id: null };
    setLines((ls) => [...ls, { key: `menu|${Date.now()}|${Math.random()}`, product, option: Object.values(choice).join(' · '), qty: 1, menu: choice }]);
  };
  const setQty = (key: string, qty: number) => setLines((ls) => qty <= 0 ? ls.filter((l) => l.key !== key) : ls.map((l) => l.key === key ? { ...l, qty } : l));
  const total = lines.reduce((s, l) => s + l.product.price_cents * l.qty, 0);
  const courses = quick ? [1] : [...new Set(lines.map((l) => l.product.course))].sort();

  const tenderedCents = Math.round(Number(tendered.replace(',', '.')) * 100) || 0;
  const charge = () => run(async () => {
    if (method === 'cash' && tendered && tenderedCents < total) throw new Error('Lo entregado es menos que el total');
    const r = await api<any>('/api/service/quick-sale', { body: {
      clientRequestId: requestId, note, method, tenderedCents: method === 'cash' && tenderedCents ? tenderedCents : null,
      items: lines.flatMap<object>((l) => l.menu ? Array.from({ length: l.qty }, () => ({ menu: l.menu })) : [{ productId: l.product.id, qty: l.qty, option: l.option }]),
    } });
    setSold({ total: r.totalCents, change: r.changeCents, documentId: r.documentId, number: r.orderNumber });
    setLines([]); setNote(''); setTendered(''); setMethod('cash'); setRequestId(newRequestId());
    onSent(null);
  });
  const send = () => run(async () => {
    const body = {
      clientRequestId: requestId, target, note, ...extraBody,
      items: lines.flatMap<object>((l) => l.menu ? Array.from({ length: l.qty }, () => ({ menu: l.menu })) : [{ productId: l.product.id, qty: l.qty, option: l.option }]),
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
              {menu.dailyMenu && <button className="chip" style={{ borderColor: 'var(--terra)', color: 'var(--terra)' }} onClick={() => setMenuOpen(true)}>{menu.dailyMenu.name} · {money(menu.dailyMenu.price_cents)}</button>}
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
            <button key={p.id} className={`product-btn ${p.photo_url ? 'with-photo' : ''}`} onClick={() => pick(p)}>
              {p.photo_url && <img src={p.photo_url} alt="" loading="lazy" />}
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
        <div className="spread"><h3 style={{ margin: 0 }}>{quick ? 'Venta rápida' : 'Comanda'}</h3><span className="badge">{targetLabel}</span></div>
        {sold && lines.length === 0 && (
          <div className="notice ok">
            <strong>Cobrado {money(sold.total)}</strong> · pedido n.º {sold.number}
            {sold.change != null && sold.change > 0 && <div style={{ fontSize: '1.4rem', fontWeight: 800, marginTop: '.2rem' }}>Cambio: {money(sold.change)}</div>}
            {sold.documentId && <button className="btn small mt" onClick={() => setTicket(sold.documentId)}>Ver ticket</button>}
          </div>
        )}
        {lines.length === 0 && <p className="muted small">Pulsa un producto para añadirlo.</p>}
        {courses.map((c) => (
          <div key={c}>
            {courses.length > 1 && <div className="small muted" style={{ marginTop: '.4rem' }}>{COURSE_LABEL[c]}{c !== courses[0] && ' · se retiene hasta «Marchar»'}</div>}
            {lines.filter((l) => quick || l.product.course === c).map((l) => (
              <div key={l.key} className="ticket-line">
                <div>
                  <div>{l.product.name}</div>
                  {l.option && <div className="small muted">{l.option}</div>}
                  <div className="small muted">{l.menu ? 'Menú · cocina y barra' : l.product.destination === 'bar' ? 'Barra' : 'Cocina'} · {money(l.product.price_cents * l.qty)}</div>
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
        <div className="spread"><strong>Total{quick ? '' : ' comanda'}</strong><strong style={quick ? { fontSize: '1.5rem' } : undefined}>{money(total)}</strong></div>
        {quick && lines.length > 0 && <>
          <div className="row" role="group" aria-label="Forma de pago" style={{ gap: '.3rem' }}>
            {([['cash', 'Efectivo'], ['card', 'Tarjeta'], ['bizum', 'Bizum']] as const).map(([k, l]) => <button key={k} className={`chip ${method === k ? 'on' : ''}`} onClick={() => setMethod(k)}>{l}</button>)}
          </div>
          {method === 'cash' && <>
            <label style={{ margin: 0 }}>Entrega el cliente (opcional)<input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder="0,00" /></label>
            <div className="row" style={{ gap: '.3rem' }}>{[5, 10, 20, 50].filter((v) => v * 100 >= total).map((v) => <button key={v} className="chip" onClick={() => setTendered(String(v))}>{v} €</button>)}</div>
            {tenderedCents >= total && tenderedCents > 0 && <div className="spread"><span>Cambio</span><strong style={{ fontSize: '1.3rem' }}>{money(tenderedCents - total)}</strong></div>}
          </>}
        </>}
        <ErrorText error={error} />
        {quick ? (
          <button className="btn primary block" style={{ fontSize: '1.15rem', padding: '.9rem' }} disabled={!lines.length || busy} onClick={charge}>
            {busy ? 'Cobrando…' : `Cobrar ${money(total)}`}
          </button>
        ) : (
          <button className="btn primary block" disabled={!lines.length || busy} onClick={send}>
            {busy ? 'Enviando…' : 'Enviar comanda'}
          </button>
        )}
      </div>

      {ticket && <DocumentPrint id={ticket} onClose={() => setTicket(null)} />}
      {menuOpen && menu.dailyMenu && <MenuChooser menu={menu.dailyMenu} onClose={() => setMenuOpen(false)} onAdd={(c) => { addMenu(c); setMenuOpen(false); }} />}
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

/** Elección de un menú del día: un plato por apartado incluido. */
export function MenuChooser({ menu, onClose, onAdd, lang = 'es' }: { menu: DailyMenu; onClose: () => void; onAdd: (choice: Record<string, string>) => void; lang?: Lang }) {
  const [choice, setChoice] = useState<Record<string, string>>({});
  const sections = MENU_SECTIONS.filter(([k]) => (menu.sections[k] ?? []).length > 0);
  const complete = sections.every(([k]) => choice[k]);
  return (
    <Modal title={`${menuName(menu.name, lang)} · ${money(menu.price_cents)}`} onClose={onClose}>
      {sections.map(([k, label]) => (
        <div key={k} style={{ marginBottom: '.75rem' }}>
          <div className="small muted" style={{ marginBottom: '.3rem' }}>{lang === 'es' ? label : t(k as 'first', lang)}</div>
          <div className="row" style={{ gap: '.35rem' }}>
            {menu.sections[k].map((o) => <button key={o} className={`chip ${choice[k] === o ? 'on' : ''}`} onClick={() => setChoice({ ...choice, [k]: o })}>{o}</button>)}
          </div>
        </div>
      ))}
      <button className="btn primary block" disabled={!complete} onClick={() => onAdd(choice)}>{complete ? t('addMenu', lang) : t('chooseEach', lang)}</button>
    </Modal>
  );
}

/** El nombre por defecto «Menú del día» se traduce; un nombre propio del local se deja tal cual. */
export const menuName = (name: string, lang: Lang) => (lang !== 'es' && name.trim().toLowerCase() === 'menú del día' ? t('dailyMenu', lang) : name);
