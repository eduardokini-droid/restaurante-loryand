import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { ErrorText, useAction } from '../components/ui';
import { LegalLinks } from './Legal';

/** Formulario público de reservas. Genera una solicitud que el local confirma. */
export default function Reservar() {
  const { slug = '' } = useParams();
  const [info, setInfo] = useState<any>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ name: '', phone: '', email: '', partySize: 2, date: tomorrow, time: '', notes: '', zonePref: '', acceptPrivacy: false, whatsappConsent: false });
  const [done, setDone] = useState<any>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { api(`/api/public/booking/${slug}`).then(setInfo).catch((e) => setProblem(e.message)); }, [slug]);

  if (problem) return <div className="center-page"><div className="card login"><h2>Reservas</h2><p>{problem}</p></div></div>;
  if (!info) return <p className="muted" style={{ padding: '2rem' }}>Cargando…</p>;
  const slots = (w: { start: string; end: string } | null) => {
    if (!w) return [];
    const out: string[] = [];
    let [h, m] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    while (h < eh || (h === eh && m <= em)) { out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`); m += 15; if (m >= 60) { h++; m -= 60; } }
    return out;
  };
  const deposit = info.depositFromParty > 0 && f.partySize >= info.depositFromParty ? info.depositPerPersonCents * f.partySize : 0;
  const send = () => run(async () => setDone(await api(`/api/public/booking/${slug}`, { body: { ...f, zonePref: f.zonePref || null } })));

  return (
    <div>
      <div className="hero"><div className="small" style={{ opacity: .85 }}>Reservar mesa</div><div className="hero-title">{info.establishment.logoUrl && <img src={info.establishment.logoUrl} alt="" className="hero-logo" />}<h1 style={{ margin: 0 }}>{info.establishment.name}</h1></div>
        <div className="small" style={{ opacity: .85 }}>{info.establishment.address} {info.establishment.city}</div></div>
      <div style={{ padding: '1rem', maxWidth: 560, margin: '0 auto' }}>
        {done ? (
          <div className="card stack">
            <h2>Solicitud enviada</h2>
            <p>Hemos recibido tu solicitud para {f.partySize} personas el {new Date(f.date).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })} a las {f.time}.</p>
            <p className="notice"><strong>Todavía no está confirmada.</strong> El restaurante la revisará y se pondrá en contacto contigo.{done.depositCents > 0 && ` Para confirmarla se requiere una fianza de ${money(done.depositCents)}.`}</p>
            {info.establishment.phone && <p className="small">¿Dudas? Llama al {info.establishment.phone}.</p>}
          </div>
        ) : (
          <div className="card">
            <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <label>Personas<input type="number" min={1} max={info.maxParty} value={f.partySize} onChange={(e) => setF({ ...f, partySize: Number(e.target.value) })} /></label>
              <label>Fecha<input type="date" min={new Date().toISOString().slice(0, 10)} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
            </div>
            <label>Hora<select value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })}>
              <option value="">Elige hora…</option>
              {info.lunch && <optgroup label="Comida">{slots(info.lunch).map((t) => <option key={t}>{t}</option>)}</optgroup>}
              {info.dinner && <optgroup label="Cena">{slots(info.dinner).map((t) => <option key={t}>{t}</option>)}</optgroup>}
            </select></label>
            <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></label>
            <label>Teléfono<input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" /></label>
            <label>Correo (opcional)<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></label>
            <label>Preferencia<select value={f.zonePref} onChange={(e) => setF({ ...f, zonePref: e.target.value })}><option value="">Sin preferencia</option><option value="salon">Salón</option><option value="terraza">Terraza</option></select></label>
            <label>Comentarios (alergias, celebración, trona…)<textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
            {deposit > 0 && <p className="notice small">Para grupos de {info.depositFromParty} o más personas se requiere una fianza de {money(deposit)}.</p>}
            {info.cancellationPolicy && <p className="small muted">{info.cancellationPolicy}</p>}
            <p className="small muted" style={{ lineHeight: 1.45 }}>{info.privacyNotice}</p>
            <label className="check"><input type="checkbox" checked={f.acceptPrivacy} onChange={(e) => setF({ ...f, acceptPrivacy: e.target.checked })} />
              <span>He leído y acepto la <a href={`/legal/${slug}`} target="_blank" rel="noreferrer">política de privacidad</a>. Si indico alergias, consiento que se usen para preparar mi servicio.</span></label>
            {info.whatsappNotice && <>
              <label className="check"><input type="checkbox" checked={f.whatsappConsent} onChange={(e) => setF({ ...f, whatsappConsent: e.target.checked })} />
                <span>Quiero recibir la confirmación y el recordatorio por WhatsApp (opcional).</span></label>
              <p className="small muted" style={{ marginTop: '-.3rem' }}>{info.whatsappNotice}</p>
            </>}
            <ErrorText error={error} />
            <button className="btn primary block" disabled={busy || !f.name || !f.phone || !f.time || !f.acceptPrivacy} onClick={send}>{busy ? 'Enviando…' : 'Solicitar reserva'}</button>
          </div>
        )}
        <LegalLinks slug={slug} />
      </div>
    </div>
  );
}
