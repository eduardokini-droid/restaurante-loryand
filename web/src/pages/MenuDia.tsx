import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toCents } from '../lib/format';
import { MENU_SECTIONS } from '../components/OrderBuilder';
import { ErrorText, useAction, useToast } from '../components/ui';

export default function MenuDia() {
  const [f, setF] = useState({ name: 'Menú del día', price: '', vatRate: 10, active: false, sections: { first: '', second: '', dessert: '', drink: '', coffee: '' } as Record<string, string> });
  const [loaded, setLoaded] = useState(false);
  const { busy, error, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    api('/api/admin/menu').then((m) => {
      if (m) setF({ name: m.name, price: (m.price_cents / 100).toFixed(2), vatRate: Number(m.vat_rate), active: m.active,
        sections: Object.fromEntries(MENU_SECTIONS.map(([k]) => [k, (m.sections[k] ?? []).join('\n')])) });
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);
  const save = () => run(async () => {
    const m = await api('/api/admin/menu', { method: 'PUT', body: { name: f.name, priceCents: toCents(f.price || '0'), vatRate: f.vatRate, active: f.active, sections: f.sections } });
    toast(m.active ? 'Menú guardado y disponible en carta, TPV y PDA' : 'Menú guardado (desactivado)');
  });
  if (!loaded) return <p className="muted">Cargando…</p>;
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>Menú del día</h1>
      <p className="muted small">Precio total por persona con IVA. Escribe cada alternativa en una línea (máximo 20 por apartado, 90 caracteres cada una). Deja vacíos los apartados que no estén incluidos. Primeros, segundos y postres van a cocina; bebidas y cafés, a barra.</p>
      <div className="card">
        <div className="grid cols-2">
          <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>Precio por persona con IVA (€)<input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
        </div>
        <div className="grid cols-2">
          {MENU_SECTIONS.map(([k, label]) => (
            <label key={k}>{label}{['first', 'second'].includes(k) ? ' (obligatorio)' : ' (opcional)'}
              <textarea rows={4} value={f.sections[k]} onChange={(e) => setF({ ...f, sections: { ...f.sections, [k]: e.target.value } })} />
            </label>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ofrecer este menú en carta, TPV y PDA</label>
        <p className="notice small">El menú sigue disponible hasta que lo desactives o lo cambies: no se actualiza solo al día siguiente.</p>
        <ErrorText error={error} />
        <button className="btn primary mt" disabled={busy} onClick={save}>Guardar menú</button>
      </div>
    </div>
  );
}
