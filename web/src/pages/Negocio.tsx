import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorText, useAction, useToast } from '../components/ui';
import { uploadImage } from '../lib/images';

export const BUSINESS_TYPE: Record<string, string> = { restaurant: 'Bar / Restaurante', bar: 'Bar', cafe: 'Cafetería', pub: 'Pub / Coctelería', bakery: 'Panadería / Pastelería', icecream: 'Heladería', other: 'Otro' };

const FIELDS: [string, string, string][] = [
  ['name', 'name', 'Nombre comercial'], ['legalName', 'legal_name', 'Razón social'], ['taxId', 'tax_id', 'DNI / CIF'],
  ['phone', 'phone', 'Teléfono'], ['email', 'email', 'Correo'], ['address', 'address', 'Dirección'],
  ['postalCode', 'postal_code', 'Código postal'], ['city', 'city', 'Localidad'], ['province', 'province', 'Provincia'],
];

export default function Negocio() {
  const { refresh, me } = useSession();
  const [incomplete, setIncomplete] = useState<string[]>([]);
  const slug = me?.establishment?.slug;
  const checkLegal = () => { if (slug) api<any>(`/api/public/legal/${slug}`).then((t) => setIncomplete(t.incomplete)).catch(() => {}); };
  useEffect(checkLegal, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<Record<string, any> | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    api('/api/admin/establishment').then((e) => setF({ ...Object.fromEntries(FIELDS.map(([k, c]) => [k, e[c] ?? ''])), businessType: e.business_type ?? 'restaurant', settings: e.settings, privacy: { contactEmail: '', registry: '', reservationMonths: 12, waitlistDays: 30, messageLogMonths: 12, ...e.privacy } })).catch(() => {});
  }, []);
  if (!f) return <p className="muted">Cargando…</p>;
  const save = () => run(async () => { await api('/api/admin/establishment', { method: 'PUT', body: f }); await refresh(); toast('Datos del establecimiento guardados'); checkLegal(); });
  const priv = (k: string, v: string | number) => setF({ ...f, privacy: { ...f.privacy, [k]: v } });
  const setting = (k: string, v: boolean) => setF({ ...f, settings: { ...f.settings, [k]: v } });
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <h1>Datos del negocio</h1>
      <LogoCard />
      <div className="card">
        <label>Tipo de negocio<select value={f.businessType} onChange={(e) => setF({ ...f, businessType: e.target.value })}>
          {Object.entries(BUSINESS_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
      </div>
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
      <div className="card">
        <h3>Protección de datos</h3>
        <p className="small muted">Con estos datos se generan la política de privacidad, el aviso legal y la política de cookies que ven tus clientes en la carta, las reservas y la tarjeta. Son modelos orientativos: revísalos con tu asesor.</p>
        {incomplete.length > 0 && <p className="notice">Faltan datos para que los textos legales estén completos: <strong>{incomplete.join(', ')}</strong>.</p>}
        <div className="grid cols-2">
          <label>Correo para ejercer los derechos (si no, el correo general)<input type="email" value={f.privacy.contactEmail} onChange={(e) => priv('contactEmail', e.target.value)} /></label>
          <label>Registro Mercantil (solo sociedades)<input value={f.privacy.registry} placeholder="Inscrita en el R. M. de …, tomo …, folio …, hoja …" onChange={(e) => priv('registry', e.target.value)} /></label>
          <label>Anonimizar reservas pasados (meses)<input type="number" min={1} max={60} value={f.privacy.reservationMonths} onChange={(e) => priv('reservationMonths', Number(e.target.value))} /></label>
          <label>Borrar la lista de espera pasados (días)<input type="number" min={1} max={365} value={f.privacy.waitlistDays} onChange={(e) => priv('waitlistDays', Number(e.target.value))} /></label>
          <label>Guardar el registro de avisos de WhatsApp (meses)<input type="number" min={1} max={60} value={f.privacy.messageLogMonths} onChange={(e) => priv('messageLogMonths', Number(e.target.value))} /></label>
        </div>
        {slug && <div className="row mt">
          <a className="btn small" href={`/legal/${slug}`} target="_blank" rel="noreferrer">Ver textos legales</a>
          <a className="btn small" href={`/legal/${slug}?cartel=1`} target="_blank" rel="noreferrer">Cartel informativo para imprimir</a>
        </div>}
      </div>
      <ErrorText error={error} />
      <button className="btn primary" disabled={busy} onClick={save}>Guardar datos del establecimiento</button>
    </div>
  );
}

/** Logotipo: se ve en la carta, las reservas, la tarjeta de cliente, el panel y las etiquetas de mesa. */
function LogoCard() {
  const { me, refresh } = useSession();
  const { busy, error, run } = useAction();
  const toast = useToast();
  const logo = me?.establishment?.logo_url;
  const pick = (file: File | undefined) => file && run(async () => {
    const img = await uploadImage(file, 'logo');
    await api('/api/admin/logo', { method: 'PUT', body: { imageId: img.id } });
    await refresh(); toast('Logotipo guardado');
  });
  const remove = () => run(async () => { await api('/api/admin/logo', { method: 'PUT', body: { imageId: null } }); await refresh(); });
  return (
    <div className="card" style={{ display: 'flex', gap: '1.2rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ width: 120, height: 120, borderRadius: 14, background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        {logo ? <img src={logo} alt="Logotipo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <span className="small muted">Sin logotipo</span>}
      </div>
      <div className="stack" style={{ flex: 1, minWidth: 220, gap: '.5rem' }}>
        <h3 style={{ margin: 0 }}>Logotipo</h3>
        <p className="small muted" style={{ margin: 0 }}>Se muestra en la carta, las reservas, la tarjeta de cliente, el panel y las etiquetas de mesa. Mejor cuadrado y con fondo transparente (PNG).</p>
        <div className="row">
          <label className="btn primary" style={{ margin: 0 }}>{busy ? 'Subiendo…' : logo ? 'Cambiar logotipo' : 'Subir logotipo'}
            <input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} /></label>
          {logo && <button className="btn ghost" disabled={busy} onClick={remove}>Quitar</button>}
        </div>
        <ErrorText error={error} />
      </div>
    </div>
  );
}
