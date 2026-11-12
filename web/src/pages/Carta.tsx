import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ALLERGENS, money, toCents } from '../lib/format';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';
import { LANGS } from '../lib/i18n';
import { uploadImage } from '../lib/images';

interface Category { id: string; parent_id: string | null; name: string; sort: number }
interface Product {
  id: string; name: string; description: string; price_cents: number; vat_rate: string; destination: string; course: number;
  visible: boolean; options: string[]; allergens: string[]; category_id: string | null; subcategory_id: string | null; photo_url: string | null;
  translations: Record<string, { name: string; description: string; manual?: boolean }>;
}

export default function Carta() {
  const [cats, setCats] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [catsOpen, setCatsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const load = useCallback(() => {
    api('/api/admin/categories').then(setCats).catch(() => {});
    api('/api/admin/products').then(setProducts).catch(() => {});
  }, []);
  useEffect(load, [load]);
  // Estado de la traducción: cuánto falta y si se está traduciendo en este momento.
  const [trStatus, setTrStatus] = useState<{ provider: string; missing: { products: number; categories: number; running: boolean } } | null>(null);
  const loadTr = useCallback(() => { api<any>('/api/admin/translation-status').then(setTrStatus).catch(() => {}); }, []);
  useEffect(loadTr, [loadTr, products.length]);
  useEffect(() => {
    if (!trStatus?.missing.running) return;
    const t = setTimeout(() => { loadTr(); load(); }, 3000);
    return () => clearTimeout(t);
  }, [trStatus, loadTr, load]);
  const translateAll = () => { api('/api/admin/translate-missing', { body: {} }).then(() => loadTr()).catch(() => {}); };
  const missing = trStatus ? trStatus.missing.products + trStatus.missing.categories : 0;
  const catName = (id: string | null) => cats.find((c) => c.id === id)?.name ?? '—';
  const shown = products.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()) && (!catFilter || p.category_id === catFilter));

  return (
    <div className="stack">
      <div className="spread"><h1>Configuración y carta</h1>
        <span className="row">
          <button className="btn" onClick={() => setCatsOpen(true)}>Categorías y subcategorías ({cats.length})</button>
          <button className="btn primary" onClick={() => setEditing('new')}>+ Añadir producto</button>
        </span></div>
      {trStatus && (missing > 0 || trStatus.missing.running) && (
        <div className="notice spread">
          <span>{trStatus.missing.running ? 'Traduciendo la carta a 6 idiomas… puedes seguir trabajando.'
            : `Faltan por traducir ${trStatus.missing.products} producto${trStatus.missing.products === 1 ? '' : 's'}${trStatus.missing.categories ? ` y ${trStatus.missing.categories} categoría${trStatus.missing.categories === 1 ? '' : 's'}` : ''}.`}</span>
          {!trStatus.missing.running && <button className="btn small primary" onClick={translateAll}>Traducir lo que falta</button>}
        </div>
      )}
      {catsOpen && <Categories cats={cats} onChange={load} onClose={() => setCatsOpen(false)} />}
      <div className="card">
        <div className="row" style={{ marginBottom: '.5rem' }}>
          <input style={{ maxWidth: 280 }} placeholder="Buscar producto" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select style={{ maxWidth: 220 }} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="">Todas las categorías</option>
            {cats.filter((c) => !c.parent_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="list">
            <thead><tr><th>Producto</th><th>Categoría</th><th>Destino</th><th className="right">Precio</th><th>Carta</th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} onClick={() => setEditing(p)} style={{ cursor: 'pointer' }}>
                  <td><strong>{p.name}</strong>{p.options.length > 0 && <div className="small muted">{p.options.length} opciones</div>}
                    {p.allergens.length === 0 && <div className="small" style={{ color: 'var(--warn)' }}>Sin alérgenos marcados</div>}</td>
                  <td>{catName(p.category_id)}{p.subcategory_id && <div className="small muted">{catName(p.subcategory_id)}</div>}</td>
                  <td><span className={`badge ${p.destination === 'bar' ? 'terra' : ''}`}>{p.destination === 'bar' ? 'Barra' : 'Cocina'}</span></td>
                  <td className="right">{money(p.price_cents)}<div className="small muted">IVA {Number(p.vat_rate)}%</div></td>
                  <td>{p.visible ? <span className="badge">Visible</span> : <span className="badge grey">Oculto</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editing && <ProductForm product={editing === 'new' ? null : editing} cats={cats} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

/** Categorías y subcategorías: crear, renombrar, ordenar y borrar. */
function Categories({ cats, onChange, onClose }: { cats: Category[]; onChange: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const { busy, error, run } = useAction();
  const roots = cats.filter((c) => !c.parent_id);
  const childrenOf = (id: string) => cats.filter((c) => c.parent_id === id);
  const add = () => run(async () => {
    const siblings = parent ? childrenOf(parent) : roots;
    await api('/api/admin/categories', { body: { name: name.trim(), parentId: parent || null, sort: siblings.length } });
    setName(''); onChange();
  });
  const rename = (c: Category) => {
    const n = prompt(`Nuevo nombre para «${c.name}»`, c.name);
    if (n && n.trim() && n.trim() !== c.name) run(async () => { await api(`/api/admin/categories/${c.id}`, { method: 'PATCH', body: { name: n.trim() } }); onChange(); });
  };
  const del = (c: Category) => run(async () => {
    if (!confirm(`¿Borrar «${c.name}»?${c.parent_id ? '' : ' También se borrarán sus subcategorías vacías.'}`)) return;
    await api(`/api/admin/categories/${c.id}`, { method: 'DELETE' }); onChange();
  });
  /** Sube o baja una categoría entre sus hermanas y guarda el orden de todas. */
  const move = (c: Category, dir: -1 | 1) => run(async () => {
    const list = c.parent_id ? childrenOf(c.parent_id) : roots;
    const i = list.findIndex((x) => x.id === c.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const order = [...list];
    [order[i], order[j]] = [order[j], order[i]];
    for (let k = 0; k < order.length; k++) if (order[k].sort !== k) await api(`/api/admin/categories/${order[k].id}`, { method: 'PATCH', body: { sort: k } });
    onChange();
  });
  const Row = ({ c, list, sub }: { c: Category; list: Category[]; sub?: boolean }) => {
    const i = list.findIndex((x) => x.id === c.id);
    return (
      <div className="spread" style={{ padding: '.4rem 0', borderBottom: '1px solid var(--line)', marginLeft: sub ? '1.4rem' : 0 }}>
        <span>{sub ? '↳ ' : ''}{sub ? c.name : <strong>{c.name}</strong>}</span>
        <span className="row" style={{ gap: '.2rem' }}>
          <button className="btn small ghost" disabled={busy || i === 0} onClick={() => move(c, -1)} aria-label={`Subir ${c.name}`}>↑</button>
          <button className="btn small ghost" disabled={busy || i === list.length - 1} onClick={() => move(c, 1)} aria-label={`Bajar ${c.name}`}>↓</button>
          <button className="btn small ghost" disabled={busy} onClick={() => rename(c)}>Renombrar</button>
          <button className="btn small ghost danger" disabled={busy} onClick={() => del(c)}>Borrar</button>
        </span>
      </div>
    );
  };
  return (
    <Modal title="Categorías y subcategorías" onClose={onClose}>
      <p className="small muted">Las categorías salen como botones en la carta del cliente y en el TPV, en este orden. Las subcategorías aparecen al pulsar su categoría.</p>
      {roots.length === 0 && <p className="muted">Todavía no hay categorías.</p>}
      {roots.map((r) => (
        <div key={r.id}>
          <Row c={r} list={roots} />
          {childrenOf(r.id).map((s) => <Row key={s.id} c={s} list={childrenOf(r.id)} sub />)}
        </div>
      ))}
      <h3 className="mt">Crear nueva</h3>
      <label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Por ejemplo: Cócteles" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) add(); }} /></label>
      <label>Dónde va
        <select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">Categoría principal (botón propio)</option>
          {roots.map((r) => <option key={r.id} value={r.id}>Subcategoría dentro de «{r.name}»</option>)}
        </select>
      </label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !name.trim()} onClick={add}>Crear {parent ? 'subcategoría' : 'categoría'}</button>
    </Modal>
  );
}

function ProductForm({ product, cats, onClose, onSaved }: { product: Product | null; cats: Category[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: product?.name ?? '', description: product?.description ?? '',
    price: product ? (product.price_cents / 100).toFixed(2) : '', vatRate: product ? Number(product.vat_rate) : 10,
    destination: product?.destination ?? 'kitchen', course: product?.course ?? 1, visible: product?.visible ?? true,
    options: product?.options.join('\n') ?? '', allergens: product?.allergens ?? [],
    categoryId: product?.category_id ?? '', subcategoryId: product?.subcategory_id ?? '', photoUrl: product?.photo_url ?? '',
  });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const [tr, setTr] = useState<Record<string, { name: string; description: string; manual?: boolean }>>(product?.translations ?? {});
  /** Lo que se escribe a mano queda marcado para que la traducción automática no lo pise. */
  const typeTr = (k: 'name' | 'description', v: string) => setTr({ ...tr, [lang]: { name: tr[lang]?.name ?? '', description: tr[lang]?.description ?? '', [k]: v, manual: true } });
  const [lang, setLang] = useState('en');
  const doneLangs = LANGS.filter(([k]) => k !== 'es' && tr[k]?.name).length;
  const autoTranslate = () => run(async () => { const p = await api(`/api/admin/products/${product!.id}/translate`, { body: {} }); setTr(p.translations); toast('Traducido a 6 idiomas. Revisa ingredientes y nombres comerciales.'); });
  const subs = cats.filter((c) => c.parent_id === f.categoryId && f.categoryId);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true); setPhotoError(null);
    try { set('photoUrl', (await uploadImage(file, 'product')).url); } catch (e) { setPhotoError((e as Error).message); } finally { setUploading(false); }
  };

  const save = () => run(async () => {
    const priceCents = toCents(f.price);
    if (!Number.isFinite(priceCents)) throw new Error('Precio no válido');
    const body = {
      name: f.name, description: f.description, priceCents, vatRate: f.vatRate, destination: f.destination, course: f.course,
      visible: f.visible, options: f.options, allergens: f.allergens, categoryId: f.categoryId || null,
      subcategoryId: f.subcategoryId || null, photoUrl: f.photoUrl || null,
      translations: Object.fromEntries(Object.entries(tr).filter(([, v]) => v.name || v.description)),
    };
    if (product) await api(`/api/admin/products/${product.id}`, { method: 'PATCH', body });
    else await api('/api/admin/products', { body });
    toast(product ? 'Cambios guardados' : 'Producto añadido a la carta');
    onSaved();
  });
  const archive = () => run(async () => {
    if (!product || !confirm('Eliminar retira el producto definitivamente. Para una falta temporal, mejor desmarca «Visible en la carta». ¿Eliminar?')) return;
    await api(`/api/admin/products/${product.id}`, { method: 'DELETE' });
    onSaved();
  });

  return (
    <Modal title={product ? 'Editar producto' : 'Añadir producto'} onClose={onClose}>
      <label>Nombre<input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
      <label>Descripción<textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
      <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label>Precio con IVA (€)<input inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} /></label>
        <label>IVA<select value={f.vatRate} onChange={(e) => set('vatRate', Number(e.target.value))}>{[10, 21, 4, 0].map((v) => <option key={v} value={v}>{v}%</option>)}</select></label>
        <label>Categoría<select value={f.categoryId} onChange={(e) => { set('categoryId', e.target.value); set('subcategoryId', ''); }}>
          <option value="">Sin categoría</option>{cats.filter((c) => !c.parent_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Subcategoría<select value={f.subcategoryId} onChange={(e) => set('subcategoryId', e.target.value)} disabled={!subs.length}>
          <option value="">Sin subcategoría</option>{subs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Destino<select value={f.destination} onChange={(e) => set('destination', e.target.value)}><option value="kitchen">Cocina</option><option value="bar">Barra</option></select></label>
        <label>Pase por defecto<select value={f.course} onChange={(e) => set('course', Number(e.target.value))}>{[1, 2, 3, 4, 5].map((c) => <option key={c} value={c}>{c}.º pase</option>)}</select></label>
      </div>
      <label>Opciones para elegir · una por línea<textarea rows={4} value={f.options} onChange={(e) => set('options', e.target.value)} placeholder={'Coca-Cola\nCoca-Cola Zero\nNaranja'} /></label>
      <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, marginBottom: '.75rem' }}>
        <legend className="small muted">Alérgenos (según ingredientes y ficha del proveedor)</legend>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '.2rem' }}>
          {Object.entries(ALLERGENS).map(([k, v]) => (
            <label key={k} className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={f.allergens.includes(k)} onChange={(e) => set('allergens', e.target.checked ? [...f.allergens, k] : f.allergens.filter((a) => a !== k))} /> {v}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row" style={{ alignItems: 'center' }}>
        <div style={{ width: 84, height: 84, borderRadius: 10, overflow: 'hidden', background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flex: 'none' }}>
          {f.photoUrl ? <img src={f.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span className="small muted">Sin foto</span>}
        </div>
        <label className="btn" style={{ margin: 0 }}>{uploading ? 'Subiendo…' : f.photoUrl ? 'Cambiar foto' : 'Subir foto'}
          <input type="file" accept="image/*" hidden disabled={uploading} onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ''; }} /></label>
        {f.photoUrl && <button type="button" className="btn ghost small" onClick={() => set('photoUrl', '')}>Quitar</button>}
      </div>
      <ErrorText error={photoError} />
      <p className="small muted" style={{ marginTop: '-.3rem' }}>La foto se ve en el TPV y en la carta del cliente. Puedes hacerla con el móvil: se reduce sola.</p>
      <details className="card" style={{ marginBottom: '.75rem' }}>
        <summary><strong>Traducciones del producto</strong> <span className="small muted">({doneLangs} de 6 idiomas)</span></summary>
        <div className="chips mt">{LANGS.filter(([k]) => k !== 'es').map(([k, l]) => <button key={k} className={`chip ${lang === k ? 'on' : ''}`} onClick={() => setLang(k)}>{l}{tr[k]?.name ? ' ✓' : ''}</button>)}</div>
        <label className="mt">Nombre<input value={tr[lang]?.name ?? ''} onChange={(e) => typeTr('name', e.target.value)} placeholder={f.name} /></label>
        <label>Descripción<textarea rows={2} value={tr[lang]?.description ?? ''} onChange={(e) => typeTr('description', e.target.value)} placeholder={f.description} /></label>
        {tr[lang]?.manual && <p className="small muted" style={{ marginTop: '-.3rem' }}>Escrita a mano: la traducción automática no la cambiará.</p>}
        {product && <button className="btn small" disabled={busy} onClick={autoTranslate}>Volver a traducir todo automáticamente</button>}
        <p className="small muted">Al guardar, el producto se traduce solo a los 6 idiomas (tarda unos segundos). Lo que escribas a mano aquí se respeta. Revisa nombres comerciales e ingredientes.</p>
      </details>
      <label className="check"><input type="checkbox" checked={f.visible} onChange={(e) => set('visible', e.target.checked)} /> Visible en la carta del cliente</label>
      <ErrorText error={error} />
      <div className="spread mt">
        {product ? <button className="btn danger" disabled={busy} onClick={archive}>Eliminar</button> : <span />}
        <button className="btn primary" disabled={busy || !f.name.trim() || !f.price} onClick={save}>{busy ? 'Guardando…' : product ? 'Guardar cambios' : 'Añadir a la carta'}</button>
      </div>
    </Modal>
  );
}
