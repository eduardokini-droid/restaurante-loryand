import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorText, useAction, useToast } from '../components/ui';

const FIELDS: [string, string, string][] = [
  ['name', 'name', 'Nombre comercial'], ['legalName', 'legal_name', 'Razón social'], ['taxId', 'tax_id', 'DNI / CIF'],
  ['phone', 'phone', 'Teléfono'], ['email', 'email', 'Correo'], ['address', 'address', 'Dirección'],
  ['postalCode', 'postal_code', 'Código postal'], ['city', 'city', 'Localidad'], ['province', 'province', 'Provincia'],
];

export default function Negocio() {
  const { refresh } = useSession();
  const [f, setF] = useState<Record<string, any> | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    api('/api/admin/establishment').then((e) => setF({ ...Object.fromEntries(FIELDS.map(([k, c]) => [k, e[c] ?? ''])), settings: e.settings })).catch(() => {});
  }, []);
  if (!f) return <p className="muted">Cargando…</p>;
  const save = () => run(async () => { await api('/api/admin/establishment', { method: 'PUT', body: f }); await refresh(); toast('Datos del establecimiento guardados'); });
  const setting = (k: string, v: boolean) => setF({ ...f, settings: { ...f.settings, [k]: v } });
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <h1>Datos del negocio</h1>
      <div className="card">
        <p className="small muted">Estos datos aparecen en tickets y facturas. Revisa el resultado con una impresión de prueba.</p>
        <div className="grid cols-2">
          {FIELDS.map(([k, , label]) => <label key={k}>{label}<input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}
        </div>
      </div>
      <div className="card">
        <h3>Servicio</h3>
        <label className="check"><input type="checkbox" checked={!!f.settings.blockPaymentUntilDelivered} onChange={(e) => setting('blockPaymentUntilDelivered', e.target.checked)} /> No permitir cobrar con productos sin entregar</label>
      </div>
      <ErrorText error={error} />
      <button className="btn primary" disabled={busy} onClick={save}>Guardar datos del establecimiento</button>
    </div>
  );
}
