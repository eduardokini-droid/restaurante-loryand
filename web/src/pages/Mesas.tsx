import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { ZONE_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { ErrorText, Modal, useAction } from '../components/ui';

interface Table { id: string; label: string; zone: string; seats: number; active: boolean; qr_token: string; join_group: string | null }
export const tableUrl = (token: string) => `${location.origin}/carta/${token}`;

export default function Mesas() {
  const [tables, setTables] = useState<Table[]>([]);
  const [form, setForm] = useState({ label: '', zone: 'salon', seats: 4 });
  const [labels, setLabels] = useState(false);
  const { busy, error, run } = useAction();
  const load = useCallback(() => { api('/api/admin/tables').then(setTables).catch(() => {}); }, []);
  useEffect(load, [load]);
  const add = () => run(async () => { await api('/api/admin/tables', { body: form }); setForm({ ...form, label: '' }); load(); });
  const patch = (t: Table, body: object) => run(async () => { await api(`/api/admin/tables/${t.id}`, { method: 'PATCH', body }); load(); });

  return (
    <div className="stack">
      <div className="spread"><h1>Mesas, QR y NFC</h1><button className="btn" onClick={() => setLabels(true)}>Imprimir etiquetas QR</button></div>
      <div className="card row">
        <input style={{ maxWidth: 120 }} placeholder="Mesa (ej. 5, T2)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <select style={{ maxWidth: 160 }} value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })}>
          {Object.entries(ZONE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input style={{ maxWidth: 100 }} type="number" min={1} value={form.seats} onChange={(e) => setForm({ ...form, seats: Number(e.target.value) })} aria-label="Plazas" />
        <button className="btn primary" disabled={busy || !form.label.trim()} onClick={add}>Añadir mesa</button>
      </div>
      <ErrorText error={error} />
      <p className="small muted">Unión: escribe la misma etiqueta (por ejemplo «A») en las mesas que juntáis habitualmente. La lista de espera las ofrecerá como una sola mesa con la suma de plazas; el programa no une mesas por su cuenta.</p>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="list">
          <thead><tr><th>Mesa</th><th>Zona</th><th>Plazas</th><th title="Mesas con la misma etiqueta se ofrecen juntas en la lista de espera y suman plazas">Unión</th><th>Enlace de la mesa (QR / NFC)</th><th>Activa</th></tr></thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.id}>
                <td><strong>{t.label}</strong></td>
                <td><select value={t.zone} onChange={(e) => patch(t, { zone: e.target.value })}>{Object.entries(ZONE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                <td><input type="number" min={1} style={{ width: 70 }} defaultValue={t.seats} onBlur={(e) => Number(e.target.value) !== t.seats && patch(t, { seats: Number(e.target.value) })} /></td>
                <td><input style={{ width: 70 }} placeholder="—" defaultValue={t.join_group ?? ''} onBlur={(e) => (e.target.value.trim() || null) !== t.join_group && patch(t, { joinGroup: e.target.value })} /></td>
                <td className="small">
                  <code style={{ wordBreak: 'break-all' }}>{tableUrl(t.qr_token)}</code>
                  <div className="row" style={{ gap: '.3rem' }}>
                    <button className="btn small" onClick={() => navigator.clipboard?.writeText(tableUrl(t.qr_token))}>Copiar (para NFC)</button>
                    <button className="btn small ghost" onClick={() => confirm('El QR impreso de esta mesa dejará de funcionar. ¿Generar uno nuevo?') && patch(t, { regenerateQr: true })}>Nuevo QR</button>
                  </div>
                </td>
                <td><input type="checkbox" checked={t.active} onChange={(e) => patch(t, { active: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {labels && <QrLabels tables={tables.filter((t) => t.active)} onClose={() => setLabels(false)} />}
    </div>
  );
}

function QrLabels({ tables, onClose }: { tables: Table[]; onClose: () => void }) {
  const { me } = useSession();
  const [selected, setSelected] = useState<string[]>(tables.map((t) => t.id));
  const [copies, setCopies] = useState(1);
  const [images, setImages] = useState<Record<string, string>>({});
  useEffect(() => {
    Promise.all(tables.map(async (t) => [t.id, await QRCode.toDataURL(tableUrl(t.qr_token), { margin: 1, width: 360 })] as const))
      .then((pairs) => setImages(Object.fromEntries(pairs)));
  }, [tables]);
  const chosen = tables.filter((t) => selected.includes(t.id));
  return (
    <Modal title="Etiquetas QR" onClose={onClose}>
      <p className="small muted">Imprime una prueba, mide el resultado y escanea cada etiqueta antes de colocarla.</p>
      <div className="row" style={{ marginBottom: '.5rem' }}>
        {tables.map((t) => (
          <label key={t.id} className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={selected.includes(t.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, t.id] : selected.filter((x) => x !== t.id))} /> {t.label}
          </label>
        ))}
      </div>
      <label>Copias por mesa (1 a 10)<input type="number" min={1} max={10} value={copies} onChange={(e) => setCopies(Math.min(10, Math.max(1, Number(e.target.value))))} /></label>
      <button className="btn primary block" onClick={() => window.print()}>Imprimir</button>
      <div className="printable" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginTop: 12 }}>
        {chosen.flatMap((t) => Array.from({ length: copies }, (_, i) => (
          <div key={`${t.id}-${i}`} style={{ border: '1px solid #ccc', borderRadius: 8, padding: 8, textAlign: 'center', background: '#fff', color: '#000', breakInside: 'avoid' }}>
            <div style={{ fontWeight: 700 }}>{me?.establishment?.name}</div>
            {images[t.id] && <img src={images[t.id]} alt={`QR mesa ${t.label}`} style={{ width: '100%' }} />}
            <div style={{ fontSize: 20, fontWeight: 800 }}>Mesa {t.label}</div>
            <div style={{ fontSize: 11 }}>Escanea para ver la carta y pedir</div>
          </div>
        )))}
      </div>
    </Modal>
  );
}
