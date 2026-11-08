import { useCallback, useEffect, useState } from 'react';
import { api, getSelectedEstablishment } from '../lib/api';
import { dateTime } from '../lib/format';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';

const KIND: Record<string, string> = { daily: 'Diaria automática', manual: 'Manual', preventive: 'Preventiva (antes de restaurar)' };
const LABEL: Record<string, string> = {
  products: 'productos', tables: 'mesas', waiters: 'camareros', accounts: 'cuentas', orders: 'pedidos', documents: 'documentos',
  reservations: 'reservas', waitlist: 'lista de espera', customers: 'clientes', stock_items: 'artículos de almacén',
};

/** Copias de seguridad y restauración (capítulo 25). */
export default function Copias() {
  const [list, setList] = useState<any[]>([]);
  const [check, setCheck] = useState<{ source: any; summary: any; problems: string[] } | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => { api('/api/backups').then(setList).catch(() => {}); }, []);
  useEffect(load, [load]);

  const verify = (source: any) => run(async () => { const r = await api('/api/backups/verify', { body: source }); setCheck({ source, ...r }); });
  const upload = (file: File) => run(async () => {
    let data: unknown;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('El archivo no es un JSON válido'); }
    const r = await api('/api/backups/verify', { body: { data } });
    setCheck({ source: { data }, ...r });
  });
  const download = async (id: string) => {
    const res = await fetch(`/api/backups/${id}/download`, { headers: { 'x-establishment-id': getSelectedEstablishment() ?? '' } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'copia.json';
    a.click();
  };

  return (
    <div className="stack" style={{ maxWidth: 960 }}>
      <div className="spread"><h1>Copias de seguridad</h1>
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api('/api/backups', { body: {} }); toast('Copia creada'); load(); })}>Crear copia ahora</button></div>
      <p className="small muted">Se hace una copia automática cada día y se conservan las 14 últimas. La copia incluye carta, mesas, camareros, ventas, documentos, reservas, <strong>lista de espera y estados de mesa</strong>, almacén y fidelización. No incluye los usuarios del panel ni sus contraseñas, ni claves de servicios externos. Descarga periódicamente una copia y guárdala fuera del programa.</p>
      <ErrorText error={error} />
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="list">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Contenido</th><th>Tamaño</th><th></th></tr></thead>
          <tbody>{list.map((b) => (
            <tr key={b.id}>
              <td>{dateTime(b.created_at)}</td><td>{KIND[b.kind]}</td>
              <td className="small">{b.summary.counts.documents} documentos · {b.summary.counts.orders} pedidos · {b.summary.counts.waitlist} en lista de espera</td>
              <td className="small">{Math.round(b.size_bytes / 1024)} KB</td>
              <td className="right"><div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                <button className="btn small" onClick={() => download(b.id)}>Descargar</button>
                <button className="btn small ghost" disabled={busy} onClick={() => verify({ backupId: b.id })}>Restaurar…</button>
              </div></td>
            </tr>
          ))}</tbody>
        </table>
        {list.length === 0 && <p className="muted">Todavía no hay copias. La primera automática se crea al minuto de arrancar el servidor.</p>}
      </div>
      <div className="card">
        <h3>Restaurar desde un archivo</h3>
        <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>
      {check && (
        <Modal title="Verificar copia" onClose={() => setCheck(null)}>
          <p><strong>{check.summary.establishment}</strong> · copia del {dateTime(check.summary.createdAt)}</p>
          <ul className="small">{Object.entries(LABEL).map(([k, v]) => <li key={k}>{check.summary.counts[k] ?? 0} {v}</li>)}</ul>
          {check.problems.length > 0 ? (
            <div className="notice"><strong>No se puede restaurar:</strong><ul>{check.problems.map((p) => <li key={p}>{p}</li>)}</ul>No fuerces la importación por otra vía: conserva el mensaje y pide revisión.</div>
          ) : (
            <>
              <p className="notice small">La restauración sustituye los datos actuales del establecimiento por los de la copia. Antes se crea automáticamente una copia preventiva. No lo hagas durante el servicio.</p>
              <button className="btn danger block" disabled={busy} onClick={() => run(async () => {
                if (!confirm('¿Sustituir los datos actuales por los de esta copia?')) return;
                await api('/api/backups/restore', { body: check.source });
                setCheck(null); toast('Copia restaurada. Se ha guardado una copia preventiva de lo anterior.'); load();
              })}>Crear copia preventiva y restaurar</button>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
