import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, newRequestId } from '../lib/api';
import { ALLERGENS, STATUS_LABEL, money } from '../lib/format';
import { useLive } from '../lib/realtime';
import { ErrorText, Modal, useAction } from '../components/ui';

interface P { id: string; name: string; description: string; price_cents: number; options: string[]; allergens: string[]; category_id: string | null; subcategory_id: string | null; photo_url: string | null }
interface Data { establishment: string; table: { label: string; accessOpen: boolean }; categories: { id: string; parent_id: string | null; name: string }[]; products: P[] }
interface Line { key: string; p: P; option: string | null; qty: number }

/** Carta digital del cliente: se abre con el QR o NFC de la mesa. */
export default function ClientMenu() {
  const { token = '' } = useParams();
  const codeKey = `loryand.code.${token}`;
  const [data, setData] = useState<Data | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [cat, setCat] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [detail, setDetail] = useState<P | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [code, setCode] = useState(() => { try { return sessionStorage.getItem(codeKey) ?? ''; } catch { return ''; } });
  const [askCode, setAskCode] = useState<null | (() => void)>(null);
  const [account, setAccount] = useState<any>(null);
  const [view, setView] = useState<'menu' | 'account'>('menu');
  const [sent, setSent] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  const { busy, error, setError, run } = useAction();

  useEffect(() => { api<Data>(`/api/public/table/${token}`).then((d) => { setData(d); setCat(d.categories.find((c) => !c.parent_id)?.id ?? null); }).catch(() => setNotFound(true)); }, [token]);
  const loadAccount = useCallback(() => {
    if (!code) return;
    api(`/api/public/table/${token}/account`, { body: { accessCode: code } }).then(setAccount).catch(() => {});
  }, [code, token]);
  useEffect(loadAccount, [loadAccount]);
  useLive(loadAccount, ['orders', 'payments'], { tableToken: token });

  const roots = data?.categories.filter((c) => !c.parent_id) ?? [];
  const sections = useMemo(() => {
    if (!data || !cat) return [];
    const subs = data.categories.filter((c) => c.parent_id === cat);
    const inCat = data.products.filter((p) => p.category_id === cat);
    const out = subs.map((s) => ({ title: s.name, items: inCat.filter((p) => p.subcategory_id === s.id) })).filter((s) => s.items.length);
    const rest = inCat.filter((p) => !p.subcategory_id);
    return rest.length ? [{ title: '', items: rest }, ...out] : out;
  }, [data, cat]);

  if (notFound) return <div className="center-page"><div className="card login"><h2>Mesa no encontrada</h2><p>Este enlace no corresponde a ninguna mesa activa. Avisa al camarero.</p></div></div>;
  if (!data) return <p className="muted" style={{ padding: '2rem' }}>Cargando carta…</p>;

  const add = (p: P, option: string | null) => {
    const key = `${p.id}|${option ?? ''}`;
    setLines((ls) => ls.some((l) => l.key === key) ? ls.map((l) => l.key === key ? { ...l, qty: l.qty + 1 } : l) : [...ls, { key, p, option, qty: 1 }]);
    setDetail(null);
  };
  const setQty = (key: string, q: number) => setLines((ls) => q <= 0 ? ls.filter((l) => l.key !== key) : ls.map((l) => l.key === key ? { ...l, qty: q } : l));
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.p.price_cents * l.qty, 0);

  const withCode = (fn: () => void) => { if (code) fn(); else setAskCode(() => fn); };
  const saveCode = (c: string) => { setCode(c); try { sessionStorage.setItem(codeKey, c); } catch { /* */ } };
  const handleCodeError = (e: unknown) => {
    const m = (e as Error).message;
    if (/clave/i.test(m)) { saveCode(''); }
    throw e;
  };

  const send = () => withCode(() => run(async () => {
    const r = await api(`/api/public/table/${token}/orders`, {
      body: { accessCode: code || sessionStorage.getItem(codeKey), clientRequestId: requestId, items: lines.map((l) => ({ productId: l.p.id, qty: l.qty, option: l.option })) },
    }).catch(handleCodeError);
    setLines([]); setCartOpen(false); setRequestId(newRequestId());
    setSent(`Pedido n.º ${r.number} recibido. Ya está en cocina o barra.`);
    loadAccount();
  }));
  const call = (kind: string) => withCode(() => run(async () => {
    await api(`/api/public/table/${token}/requests`, { body: { accessCode: code || sessionStorage.getItem(codeKey), kind } }).catch(handleCodeError);
    setSent(kind === 'pay' ? 'Hemos avisado: el camarero te traerá la cuenta.' : 'Hemos avisado al camarero.');
  }));

  return (
    <div style={{ paddingBottom: 90 }}>
      <header className="hero" style={{ padding: '1.25rem 1rem' }}>
        <div className="small" style={{ opacity: .85 }}>Mesa {data.table.label}</div>
        <h1 style={{ margin: 0 }}>{data.establishment}</h1>
        <div className="row mt" style={{ gap: '.4rem' }}>
          <button className={`chip ${view === 'menu' ? 'on' : ''}`} onClick={() => setView('menu')}>Carta</button>
          <button className={`chip ${view === 'account' ? 'on' : ''}`} onClick={() => withCode(() => { loadAccount(); setView('account'); })}>Mi pedido</button>
          <button className="chip" onClick={() => call('waiter')}>Llamar al camarero</button>
          <button className="chip" onClick={() => call('pay')}>Quiero pagar</button>
        </div>
      </header>
      {sent && <div className="notice ok" style={{ margin: '1rem' }}>{sent} <button className="btn small ghost" onClick={() => setSent(null)}>✕</button></div>}
      {!data.table.accessOpen && <div className="notice" style={{ margin: '1rem' }}>Los pedidos desde el teléfono están cerrados en esta mesa. Puedes consultar la carta y pedir al camarero.</div>}
      <ErrorText error={error} />

      {view === 'menu' ? (
        <div style={{ padding: '0 1rem' }}>
          <div className="chips" style={{ position: 'sticky', top: 0, background: 'var(--cream)', padding: '.75rem 0', zIndex: 2 }}>
            {roots.map((c) => <button key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>)}
          </div>
          {sections.map((s) => (
            <section key={s.title} style={{ marginBottom: '1rem' }}>
              {s.title && <h2>{s.title}</h2>}
              <div className="stack">
                {s.items.map((p) => (
                  <button key={p.id} className="card" style={{ textAlign: 'left', display: 'flex', gap: '.75rem', cursor: 'pointer', width: '100%' }} onClick={() => setDetail(p)}>
                    {p.photo_url && <img src={p.photo_url} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8 }} />}
                    <span style={{ flex: 1 }}>
                      <span className="spread"><strong>{p.name}</strong><strong>{money(p.price_cents)}</strong></span>
                      {p.description && <span className="small muted" style={{ display: 'block' }}>{p.description}</span>}
                      {p.allergens.length > 0 && <span className="small" style={{ display: 'block', color: 'var(--terra)' }}>Contiene: {p.allergens.map((a) => ALLERGENS[a]).join(', ')}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          <p className="small muted">¿Alergias o intolerancias? Pregunta al personal antes de pedir. Las fotos son orientativas y no permiten descartar trazas.</p>
        </div>
      ) : (
        <div style={{ padding: '1rem' }} className="stack">
          <h2>Lo que lleva la mesa</h2>
          {!account?.items?.length && <p className="muted">Todavía no hay nada pedido.</p>}
          {account?.items?.map((i: any, k: number) => (
            <div key={k} className="ticket-line"><span>{i.qty} × {i.name}{i.option && <span className="muted"> · {i.option}</span>}<div className="small muted">{STATUS_LABEL[i.status]}</div></span><span>{money(i.unitCents * i.qty)}</span></div>
          ))}
          {account && <div className="spread"><strong>Pendiente</strong><strong>{money(account.pendingCents)}</strong></div>}
        </div>
      )}

      {count > 0 && view === 'menu' && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '.75rem 1rem', background: 'var(--paper)', borderTop: '1px solid var(--line)' }}>
          <button className="btn primary block" onClick={() => setCartOpen(true)}>Ver pedido · {count} · {money(total)}</button>
        </div>
      )}

      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)}>
          {detail.photo_url && <img src={detail.photo_url} alt="" style={{ width: '100%', borderRadius: 10 }} />}
          {detail.description && <p>{detail.description}</p>}
          <p className="small">{detail.allergens.length ? <>Alérgenos: {detail.allergens.map((a) => ALLERGENS[a]).join(', ')}</> : 'Sin alérgenos declarados. Ante cualquier alergia, consulta al personal.'}</p>
          {data.table.accessOpen && (detail.options.length ? (
            <div className="grid tiles">{detail.options.map((o) => <button key={o} className="product-btn" onClick={() => add(detail, o)}><strong>{o}</strong><span className="small">{money(detail.price_cents)}</span></button>)}</div>
          ) : <button className="btn primary block" onClick={() => add(detail, null)}>Añadir · {money(detail.price_cents)}</button>)}
        </Modal>
      )}

      {cartOpen && (
        <Modal title="Tu pedido" onClose={() => setCartOpen(false)}>
          {lines.map((l) => (
            <div key={l.key} className="ticket-line">
              <span>{l.p.name}{l.option && <div className="small muted">{l.option}</div>}<div className="small">{money(l.p.price_cents * l.qty)}</div></span>
              <span className="qty"><button onClick={() => setQty(l.key, l.qty - 1)}>−</button><strong>{l.qty}</strong><button onClick={() => setQty(l.key, l.qty + 1)}>+</button></span>
            </div>
          ))}
          <div className="spread mt"><strong>Total</strong><strong>{money(total)}</strong></div>
          <p className="small muted">Comprueba que pone Mesa {data.table.label}. Si no es tu mesa, no envíes el pedido y avisa al camarero.</p>
          <ErrorText error={error} />
          <button className="btn primary block" disabled={busy} onClick={send}>{busy ? 'Enviando…' : 'Enviar pedido'}</button>
        </Modal>
      )}

      {askCode && (
        <Modal title="Clave de la mesa" onClose={() => setAskCode(null)}>
          <p>Pide la clave al camarero e introdúcela aquí.</p>
          <CodeForm token={token} onOk={(c) => { saveCode(c); const fn = askCode; setAskCode(null); setError(null); setTimeout(fn, 0); }} />
        </Modal>
      )}
    </div>
  );
}

function CodeForm({ token, onOk }: { token: string; onOk: (code: string) => void }) {
  const [c, setC] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/api/public/table/${token}/verify`, { body: { accessCode: c } }); onOk(c); }); }}>
      <input autoFocus inputMode="numeric" value={c} onChange={(e) => setC(e.target.value.replace(/\D/g, '').slice(0, 6))} style={{ fontSize: '1.5rem', letterSpacing: '.3em', textAlign: 'center' }} aria-label="Clave de la mesa" />
      <ErrorText error={error} />
      <button className="btn primary block mt" disabled={busy || c.length < 4}>Continuar</button>
    </form>
  );
}
