import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ALLERGENS, money, toCents } from '../lib/format';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';
import { LANGS } from '../lib/i18n';

interface Category { id: string; parent_id: string | null; name: string; sort: number }
interface Product {
  id: string; name: string; description: string; price_cents: number; vat_rate: string; destination: string; course: number;
  visible: boolean; options: string[]; allergens: string[]; category_id: string | null; subcategory_id: string | null; photo_url: string | null;
  translations: Record<string, { name: string; description: string }>;
}

export default function Carta() {
  const [cats, setCats] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [filter, setFilter] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const load = useCallback(() => {
    api('/api/admin/categories').then(setCats).catch(() => {});
    api('/api/admin/products').then(setProducts).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const catName = (id: string | null) => cats.find((c) => c.id === id)?.name ?? '—';
  const shown = products.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()) && (!catFilter || p.category_id === catFilter));

  return (
    <div className="stack">
      <div className="spread"><h1>Configuración y carta</h1><button className="btn primary" onClick={() => setEditing('new')}>+ Añadir producto</button></div>
      <Categories cats={cats} onChange={load} />
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

function Categories({ cats, onChange }: { cats: Category[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const { busy, error, run } = useAction();
  const add = () => run(async () => { await api('/api/admin/categories', { body: { name, parentId: parent || null } }); setName(''); onChange(); });
  const del = (c: Category) => run(async () => { if (confirm(`¿Borrar la categoría «${c.name}»?`)) { await api(`/api/admin/categories/${c.id}`, { method: 'DELETE' }); onChange(); } });
  const roots = cats.filter((c) => !c.parent_id);
  return (
    <details className="card">
      <summary><strong>Categorías y subcategorías</strong> <span className="muted small">({cats.length})</span></summary>
      <div className="mt">
        {roots.map((r) => (
          <div key={r.id} style={{ marginBottom: '.5rem' }}>
            <strong>{r.name}</strong> <button className="btn small ghost" disabled={busy} onClick={() => del(r)}>borrar</button>
            <div className="row small" style={{ gap: '.35rem', marginLeft: '1rem' }}>
              {cats.filter((c) => c.parent_id === r.id).map((s) => <span key={s.id} className="badge grey">{s.name} <button className="btn ghost small" style={{ minHeight: 0, padding: 0 }} onClick={() => del(s)}>✕</button></span>)}
            </div>
          </div>
        ))}
        <div className="row mt">
          <input style={{ maxWidth: 220 }} placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
          <select style={{ maxWidth: 240 }} value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">Categoría principal</option>
            {roots.map((r) => <option key={r.id} value={r.id}>Subcategoría de {r.name}</option>)}
          </select>
          <button className="btn" disabled={busy || !name.trim()} onClick={add}>Crear</button>
        </div>
        <ErrorText error={error} />
      </div>
    </details>
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
  const [tr, setTr] = useState<Record<string, { name: string; description: string }>>(product?.translations ?? {});
  const [lang, setLang] = useState('en');
  const doneLangs = LANGS.filter(([k]) => k !== 'es' && tr[k]?.name).length;
  const autoTranslate = () => run(async () => { const p = await api(`/api/admin/products/${product!.id}/translate`, { body: {} }); setTr(p.translations); toast('Traducido a 6 idiomas. Revisa ingredientes y nombres comerciales.'); });
  const subs = cats.filter((c) => c.parent_id === f.categoryId && f.categoryId);

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
      <label>URL de la foto (opcional)<input value={f.photoUrl} onChange={(e) => set('photoUrl', e.target.value)} placeholder="https://…" /></label>
      <details className="card" style={{ marginBottom: '.75rem' }}>
        <summary><strong>Traducciones del producto</strong> <span className="small muted">({doneLangs} de 6 idiomas)</span></summary>
        <div className="chips mt">{LANGS.filter(([k]) => k !== 'es').map(([k, l]) => <button key={k} className={`chip ${lang === k ? 'on' : ''}`} onClick={() => setLang(k)}>{l}{tr[k]?.name ? ' ✓' : ''}</button>)}</div>
        <label className="mt">Nombre<input value={tr[lang]?.name ?? ''} onChange={(e) => setTr({ ...tr, [lang]: { name: e.target.value, description: tr[lang]?.description ?? '' } })} placeholder={f.name} /></label>
        <label>Descripción<textarea rows={2} value={tr[lang]?.description ?? ''} onChange={(e) => setTr({ ...tr, [lang]: { name: tr[lang]?.name ?? '', description: e.target.value } })} placeholder={f.description} /></label>
        {product && <button className="btn small" disabled={busy} onClick={autoTranslate}>Traducir automáticamente desde el español</button>}
        <p className="small muted">Si cambias el nombre o la descripción en español, revisa también las traducciones. No traduzcas marcas comerciales.</p>
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
