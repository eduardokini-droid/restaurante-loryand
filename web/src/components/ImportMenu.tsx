import { useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { uploadImage } from '../lib/images';
import { ErrorText, Modal } from './ui';

interface ImportProduct {
  nombre: string; descripcion?: string; precioCentimos: number; iva?: number; destino?: 'bar' | 'kitchen';
  categoria?: string; subcategoria?: string; foto?: string; alergenos?: string[]; opciones?: string[];
}
interface ImportFile { formato: string; categorias?: { nombre: string; subcategorias?: string[] }[]; productos: ImportProduct[] }
interface Cat { id: string; parent_id: string | null; name: string }

/** «image_5.jpg», «image 5.jpg» e «IMAGE 5.JPG» son la misma foto. */
const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();

/**
 * Importar una carta preparada por Loryand: un archivo con categorías y productos y, aparte, las fotos.
 * Las fotos se emparejan por el nombre del archivo. Los productos que ya existen con el mismo nombre se saltan.
 */
export function ImportMenu({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<ImportFile | null>(null);
  const [photos, setPhotos] = useState<Map<string, File>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; log: string[] } | null>(null);
  const [finished, setFinished] = useState(false);

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const j = JSON.parse(await f.text()) as ImportFile;
      if (j.formato !== 'loryand-carta' || !Array.isArray(j.productos)) throw new Error('Este archivo no es una carta de Loryand');
      setFile(j);
    } catch (e) { setError((e as Error).message.startsWith('Este') ? (e as Error).message : 'No se puede leer el archivo de la carta'); }
  };
  const readPhotos = (list: FileList | null) => {
    const m = new Map(photos);
    for (const f of Array.from(list ?? [])) if (f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name)) m.set(norm(f.name), f);
    setPhotos(m);
  };
  const withPhoto = file?.productos.filter((p) => p.foto && photos.has(norm(p.foto))).length ?? 0;
  const missing = file?.productos.filter((p) => p.foto && !photos.has(norm(p.foto))) ?? [];

  const run = async () => {
    if (!file) return;
    const log: string[] = [];
    const total = file.productos.length;
    setProgress({ done: 0, total, log });
    try {
      const [cats, existing] = await Promise.all([api<Cat[]>('/api/admin/categories'), api<{ name: string }[]>('/api/admin/products')]);
      const names = new Set(existing.map((p) => p.name.toLowerCase()));
      const findCat = (name: string, parent: string | null) => cats.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.parent_id === parent);
      const ensureCat = async (name: string, parent: string | null) => {
        const found = findCat(name, parent);
        if (found) return found.id;
        const siblings = cats.filter((c) => c.parent_id === parent).length;
        const c = await api<Cat>('/api/admin/categories', { body: { name, parentId: parent, sort: siblings } });
        cats.push(c);
        return c.id;
      };
      for (const c of file.categorias ?? []) {
        const id = await ensureCat(c.nombre, null);
        for (const s of c.subcategorias ?? []) await ensureCat(s, id);
      }
      let done = 0;
      for (const p of file.productos) {
        if (names.has(p.nombre.toLowerCase())) {
          log.push(`Ya existía, no se toca: ${p.nombre}`);
        } else {
          const categoryId = p.categoria ? await ensureCat(p.categoria, null) : null;
          const subcategoryId = p.subcategoria && categoryId ? await ensureCat(p.subcategoria, categoryId) : null;
          let photoUrl: string | null = null;
          const photo = p.foto ? photos.get(norm(p.foto)) : undefined;
          if (photo) {
            try { photoUrl = (await uploadImage(photo, 'product')).url; } catch (e) { log.push(`Sin foto (${(e as Error).message}): ${p.nombre}`); }
          }
          await api('/api/admin/products', { body: {
            name: p.nombre, description: p.descripcion ?? '', priceCents: p.precioCentimos, vatRate: p.iva ?? 10,
            destination: p.destino ?? 'kitchen', categoryId, subcategoryId, photoUrl, allergens: p.alergenos ?? [], options: p.opciones ?? [],
          } });
          names.add(p.nombre.toLowerCase());
        }
        done++;
        setProgress({ done, total, log: [...log] });
      }
      setFinished(true);
      onDone();
    } catch (e) {
      setError(`Se ha parado la importación: ${(e as Error).message}. Puedes volver a lanzarla: lo ya importado no se duplica.`);
    }
  };

  return (
    <Modal title="Importar carta" onClose={onClose}>
      {!progress && <>
        <p className="small muted">1. Elige el archivo de la carta que te ha preparado Loryand. 2. Elige todas las fotos de la carpeta (puedes seleccionarlas todas a la vez). Los productos que ya existan con el mismo nombre no se tocan.</p>
        <label className="btn block" style={{ margin: '.3rem 0' }}>{file ? `Carta: ${file.productos.length} productos ✓` : '1. Elegir archivo de la carta'}
          <input type="file" accept=".json,application/json" hidden onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <label className="btn block" style={{ margin: '.3rem 0' }}>{photos.size ? `Fotos elegidas: ${photos.size} ✓ (añadir más)` : '2. Elegir las fotos'}
          <input type="file" accept="image/*" multiple hidden onChange={(e) => { readPhotos(e.target.files); e.target.value = ''; }} /></label>
        {file && (
          <div className="card" style={{ maxHeight: 260, overflowY: 'auto', marginTop: '.5rem' }}>
            <div className="small"><strong>{file.productos.length}</strong> productos · <strong>{withPhoto}</strong> con foto encontrada{missing.length > 0 && <> · <span style={{ color: 'var(--terra)' }}>faltan {missing.length} fotos</span></>}</div>
            <table className="list small mt"><tbody>{file.productos.map((p) => (
              <tr key={p.nombre}><td>{p.foto && photos.has(norm(p.foto)) ? '📷' : '—'}</td><td>{p.nombre}<div className="muted">{[p.categoria, p.subcategoria].filter(Boolean).join(' › ')}</div></td><td className="right">{money(p.precioCentimos)}</td></tr>
            ))}</tbody></table>
          </div>
        )}
        <ErrorText error={error} />
        <button className="btn primary block mt" disabled={!file} onClick={run}>{missing.length ? `Importar (${missing.length} sin foto)` : 'Importar carta'}</button>
      </>}
      {progress && <>
        <p>{finished ? 'Carta importada.' : 'Importando… no cierres esta ventana.'} {progress.done} de {progress.total}</p>
        <div style={{ height: 10, background: 'var(--line)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(progress.done / progress.total) * 100}%`, background: 'var(--green)', transition: 'width .2s' }} />
        </div>
        {progress.log.length > 0 && <ul className="small muted mt">{progress.log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        {finished && <p className="small muted mt">Los productos se están traduciendo solos en segundo plano. Revisa ahora sus alérgenos: entra en cada producto y márcalos.</p>}
        <ErrorText error={error} />
        {(finished || error) && <button className="btn primary block mt" onClick={onClose}>Cerrar</button>}
      </>}
    </Modal>
  );
}
