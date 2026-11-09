import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../lib/api';

interface Section { title: string; paragraphs: string[] }
export interface LegalTexts {
  version: string; incomplete: string[];
  owner: { name: string; legalName: string; taxId: string; address: string; email: string; phone: string };
  privacy: Section[]; legalNotice: Section[]; cookies: Section[];
  layers: Record<'reservation' | 'waitlist' | 'loyalty' | 'whatsapp' | 'menu', string>;
}

const DOCS = { privacidad: 'Política de privacidad', aviso: 'Aviso legal', cookies: 'Cookies' } as const;
type Doc = keyof typeof DOCS;

/** Textos legales públicos del local. Con ?cartel=1, cartel imprimible para el mostrador. */
export default function Legal() {
  const { slug } = useParams();
  const [params, setParams] = useSearchParams();
  const doc = (params.get('doc') as Doc) in DOCS ? (params.get('doc') as Doc) : 'privacidad';
  const [t, setT] = useState<LegalTexts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<LegalTexts>(`/api/public/legal/${slug}`).then(setT).catch((e) => setErr(e.message)); }, [slug]);
  if (err) return <div className="center-page"><p className="error">{err}</p></div>;
  if (!t) return <div className="center-page"><p className="muted">Cargando…</p></div>;
  if (params.get('cartel')) return <Poster t={t} slug={slug!} />;
  const sections = doc === 'privacidad' ? t.privacy : doc === 'aviso' ? t.legalNotice : t.cookies;
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem 1rem 3rem' }} className="legal">
      <div className="small muted">{t.owner.name}</div>
      <h1 style={{ marginTop: '.2rem' }}>{DOCS[doc]}</h1>
      <nav className="row" style={{ gap: '.4rem', marginBottom: '1rem' }} aria-label="Documentos">
        {(Object.keys(DOCS) as Doc[]).map((k) => (
          <button key={k} className={`chip ${k === doc ? 'on' : ''}`} onClick={() => setParams({ doc: k })} aria-current={k === doc ? 'page' : undefined}>{DOCS[k]}</button>
        ))}
      </nav>
      {sections.map((s) => (
        <section key={s.title} style={{ marginBottom: '1.2rem' }}>
          <h3>{s.title}</h3>
          {s.paragraphs.map((p, i) => <p key={i} style={{ lineHeight: 1.55 }}>{p}</p>)}
        </section>
      ))}
      <p className="small muted">Versión {t.version}</p>
    </div>
  );
}

/** Cartel informativo (primera capa) para colocar junto a la caja o en la entrada. */
function Poster({ t, slug }: { t: LegalTexts; slug: string }) {
  const [qr, setQr] = useState('');
  const url = `${location.origin}/legal/${slug}`;
  useEffect(() => { QRCode.toDataURL(url, { width: 300, margin: 1 }).then(setQr); }, [url]);
  return (
    <div className="printable" style={{ maxWidth: 680, margin: '0 auto', padding: '1.5rem', background: '#fff', color: '#1d1d1b' }}>
      <div className="no-print row" style={{ marginBottom: '1rem' }}><button className="btn primary" onClick={() => window.print()}>Imprimir</button><Link className="btn" to={`/legal/${slug}`}>Ver textos completos</Link></div>
      <h1 style={{ margin: 0 }}>Protección de datos</h1>
      <p style={{ marginTop: '.3rem' }}><strong>{t.owner.legalName}</strong>{t.owner.taxId && ` · NIF ${t.owner.taxId}`}{t.owner.address && ` · ${t.owner.address}`}</p>
      <h3>Programa de fidelización</h3><p>{t.layers.loyalty}</p>
      <h3>Lista de espera</h3><p>{t.layers.waitlist}</p>
      <h3>Avisos por WhatsApp</h3><p>{t.layers.whatsapp}</p>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '1rem' }}>
        {qr && <img src={qr} width={130} height={130} alt="Código QR de la política de privacidad" />}
        <p className="small">Política de privacidad completa:<br /><strong>{url}</strong></p>
      </div>
    </div>
  );
}

/** Enlaces al pie de las páginas públicas. */
export function LegalLinks({ slug }: { slug?: string | null }) {
  if (!slug) return null;
  return (
    <p className="small muted" style={{ textAlign: 'center', margin: '1.5rem 0 .5rem' }}>
      <a href={`/legal/${slug}`} target="_blank" rel="noreferrer">Privacidad</a> · <a href={`/legal/${slug}?doc=aviso`} target="_blank" rel="noreferrer">Aviso legal</a> · <a href={`/legal/${slug}?doc=cookies`} target="_blank" rel="noreferrer">Cookies</a>
    </p>
  );
}
