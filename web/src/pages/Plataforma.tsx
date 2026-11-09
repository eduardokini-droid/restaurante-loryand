import { useCallback, useEffect, useState } from 'react';
import { api, setSelectedEstablishment } from '../lib/api';
import { money, toCents } from '../lib/format';
import { useSession } from '../lib/session';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';

type Tab = 'clientes' | 'planes' | 'facturas' | 'incidencias' | 'emisor';
const TABS: [Tab, string][] = [['clientes', 'Clientes'], ['planes', 'Planes'], ['facturas', 'Facturas y remesas'], ['incidencias', 'Incidencias'], ['emisor', 'Datos de facturación']];
export const CONTRACT_STATUS: Record<string, string> = { active: 'Activo', paused: 'En pausa', cancelled: 'Baja' };
export const PAY_METHOD: Record<string, string> = { transfer: 'Transferencia', direct_debit: 'Domiciliación', card: 'Tarjeta', other: 'Otra' };
export const TICKET_STATUS: Record<string, string> = { open: 'Abierta', in_progress: 'En curso', waiting: 'Esperando al cliente', resolved: 'Resuelta' };
export const TICKET_PRIORITY: Record<string, string> = { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
export const TICKET_CATEGORY: Record<string, string> = { bug: 'Fallo del programa', question: 'Duda', hardware: 'Impresora o equipos', billing: 'Facturación', request: 'Petición de mejora', other: 'Otro' };
const thisMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 7);
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('es-ES');

/** Panel del gestor general de Loryand: clientes y contratos, facturación e incidencias. */
export default function Plataforma() {
  const { logout } = useSession();
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem('loryand-plataforma-tab') as Tab) || 'clientes');
  const [summary, setSummary] = useState<any>(null);
  const loadSummary = useCallback(() => { api('/api/platform/summary').then(setSummary).catch(() => {}); }, []);
  useEffect(loadSummary, [loadSummary, tab]);
  const go = (t: Tab) => { setTab(t); try { sessionStorage.setItem('loryand-plataforma-tab', t); } catch { /* sin almacenamiento */ } };
  return (
    <div style={{ padding: '1.5rem', maxWidth: 1180, margin: '0 auto' }} className="stack">
      <div className="spread"><h1 style={{ margin: 0 }}>Gestor general · Loryand</h1>
        <span className="row"><a className="btn" href="/gestion/cuenta">Mi cuenta</a><button className="btn" onClick={logout}>Salir</button></span></div>
      {summary && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Tile label="Facturación prevista este mes (con IVA)" value={money(summary.expected_month_cents)} note={`${summary.active_contracts} contratos activos · según mesas activas ahora`} />
          <Tile label="Pendiente de cobro" value={money(summary.pending_cents)} note={summary.overdue ? `${summary.overdue} facturas vencidas` : 'Nada vencido'} warn={summary.overdue > 0} />
          <Tile label="Impagos" value={String(summary.returned)} note={summary.returned ? 'Recibos devueltos por el banco' : 'Ningún recibo devuelto'} warn={summary.returned > 0} />
          <Tile label="Incidencias abiertas" value={String(summary.open_tickets)} note={summary.unread_tickets ? `${summary.unread_tickets} con mensajes sin leer` : 'Todo leído'} warn={summary.unread_tickets > 0} />
        </div>
      )}
      <nav className="row" style={{ gap: '.4rem' }} aria-label="Secciones">
        {TABS.map(([k, l]) => <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => go(k)} aria-current={tab === k ? 'page' : undefined}>{l}</button>)}
      </nav>
      {tab === 'clientes' && <Clientes onChange={loadSummary} />}
      {tab === 'planes' && <Planes />}
      {tab === 'facturas' && <Facturas onChange={loadSummary} />}
      {tab === 'incidencias' && <Incidencias onChange={loadSummary} />}
      {tab === 'emisor' && <Emisor />}
    </div>
  );
}

const Tile = ({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) => (
  <div className="card"><div className="small muted">{label}</div><div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{value}</div>{note && <div className={`small ${warn ? '' : 'muted'}`} style={warn ? { color: 'var(--terra)', fontWeight: 600 } : undefined}>{note}</div>}</div>
);

// ---------------- Clientes ----------------
function Clientes({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<any[]>([]);
  const [contract, setContract] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const { error, run } = useAction();
  const load = useCallback(() => { api<any[]>('/api/platform/clients').then(setList).catch(() => {}); }, []);
  useEffect(load, [load]);
  const enter = (id: string) => { setSelectedEstablishment(id); location.assign('/gestion'); };
  const toggle = (e: any) => run(async () => {
    if (e.active && !confirm(`Desactivar «${e.name}» corta el acceso a todo su personal. ¿Continuar?`)) return;
    await api(`/api/platform/establishments/${e.id}`, { method: 'PATCH', body: { active: !e.active } }); load(); onChange();
  });
  return (
    <div className="stack">
      <div className="spread"><h2 style={{ margin: 0 }}>Clientes</h2><button className="btn primary" onClick={() => setCreating(true)}>+ Nuevo establecimiento</button></div>
      <ErrorText error={error} />
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="list">
          <thead><tr><th>Establecimiento</th><th>Plan</th><th className="right">Mesas</th><th className="right">Cuota estimada</th><th className="right">Pendiente</th><th className="right">Incid.</th><th></th></tr></thead>
          <tbody>{list.map((e) => (
            <tr key={e.id} style={e.active ? undefined : { opacity: .55 }}>
              <td style={{ minWidth: 180 }}><strong>{e.name}</strong><div className="small muted"><code>{e.slug}</code> · {e.active_tables} mesas{!e.active && ' · desactivado'}</div></td>
              <td>{e.plan_name ? <>{e.plan_name}<div className="small muted">{CONTRACT_STATUS[e.contract_status]} · {PAY_METHOD[e.payment_method]}{e.payment_method === 'direct_debit' && !(e.iban_last4 && e.mandate_ref) && ' (falta mandato)'}</div>
                {e.renewal_date && <Renewal date={e.renewal_date} />}</> : <span className="badge grey">Sin contrato</span>}</td>
              <td className="right">{e.active_tables}<div className="small muted">máx. mes {e.max_tables_month}</div></td>
              <td className="right">{e.plan_name ? money(e.monthly_cents + e.price_per_table_cents * Math.max(e.active_tables, e.max_tables_month)) : '—'}{e.plan_name && <div className="small muted">+ IVA{e.price_per_table_cents > 0 && ` · ${money(e.price_per_table_cents)}/mesa`}</div>}</td>
              <td className="right">{e.pending_cents ? money(e.pending_cents) : '—'}{e.overdue > 0 && <div><span className="badge danger">{e.overdue} vencida{e.overdue > 1 ? 's' : ''}</span></div>}{e.returned > 0 && <div><span className="badge danger">{e.returned} devuelto{e.returned > 1 ? 's' : ''}</span></div>}</td>
              <td className="right">{e.open_tickets || '—'}</td>
              <td className="right"><div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                <button className="btn small primary" onClick={() => enter(e.id)}>Entrar</button>
                <button className="btn small" onClick={() => setContract(e)}>Contrato</button>
                <button className="btn small ghost" onClick={() => toggle(e)}>{e.active ? 'Desactivar' : 'Activar'}</button>
              </div></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {contract && <ContractModal e={contract} onClose={() => setContract(null)} onSaved={() => { setContract(null); load(); onChange(); }} />}
      {creating && <NewEstablishment onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
    </div>
  );
}

export const FEATURE_LABEL: Record<string, string> = {
  menu: 'Carta QR y pedidos', pda: 'PDA camareros', kitchen: 'Cocina', bar: 'Barra', tpv: 'TPV', cash: 'Ventas, caja e informes',
  reservations: 'Reservas', stock: 'Almacén', loyalty: 'Fidelización', online: 'Cobro online y WhatsApp',
};
const FEATURES = Object.keys(FEATURE_LABEL);
const euros = (c: number) => (c / 100).toFixed(2).replace('.', ',');

function Renewal({ date }: { date: string }) {
  const days = Math.round((new Date(`${date}T12:00:00`).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return <div><span className="badge danger">Renovación vencida {fmtDate(date)}</span></div>;
  if (days <= 30) return <div><span className="badge warn">Renueva el {fmtDate(date)}</span></div>;
  return <div className="small muted">Renueva el {fmtDate(date)}</div>;
}

function ContractModal({ e, onClose, onSaved }: { e: any; onClose: () => void; onSaved: () => void }) {
  const [plans, setPlans] = useState<any[]>([]);
  useEffect(() => { api<any[]>('/api/platform/plans').then(setPlans).catch(() => {}); }, []);
  const [f, setF] = useState({
    planId: e.plan_id ?? '', planName: e.plan_name ?? 'Personalizado', monthly: euros(e.monthly_cents ?? 0), perTable: euros(e.price_per_table_cents ?? 0),
    vatRate: String(e.vat_rate ?? 21), startDate: e.start_date ?? new Date().toISOString().slice(0, 10), renewalDate: e.renewal_date ?? '',
    status: e.contract_status ?? 'active', paymentMethod: e.payment_method ?? 'transfer',
    iban: '', mandateRef: e.mandate_ref || `LORYAND-${String(e.slug).toUpperCase()}`, mandateDate: e.mandate_date ?? '',
    billingName: e.billing_name ?? '', billingTaxId: e.billing_tax_id ?? '', billingAddress: e.billing_address ?? '', billingEmail: e.billing_email ?? '', notes: e.notes ?? '',
  });
  const [features, setFeatures] = useState<string[]>(e.features ?? []);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const plan = plans.find((p) => p.id === f.planId);
  const pickPlan = (id: string) => {
    const p = plans.find((x) => x.id === id);
    setF({ ...f, planId: id, ...(p ? { planName: p.name, monthly: euros(p.monthly_cents), perTable: euros(p.price_per_table_cents) } : { planName: 'Personalizado' }) });
  };
  const save = () => run(async () => {
    const body: Record<string, unknown> = {
      planId: f.planId || null, planName: f.planName, monthlyCents: toCents(f.monthly || '0'), pricePerTableCents: toCents(f.perTable || '0'),
      vatRate: Number(f.vatRate.replace(',', '.')), startDate: f.startDate, renewalDate: f.renewalDate || null, status: f.status, paymentMethod: f.paymentMethod,
      mandateRef: f.mandateRef.trim(), mandateDate: f.mandateDate || null,
      billingName: f.billingName, billingTaxId: f.billingTaxId, billingAddress: f.billingAddress, billingEmail: f.billingEmail, notes: f.notes,
    };
    if (f.iban.trim()) body.iban = f.iban;
    await api(`/api/platform/clients/${e.id}/contract`, { method: 'PUT', body });
    if (!f.planId) await api(`/api/platform/establishments/${e.id}`, { method: 'PATCH', body: { features } });
    toast('Contrato guardado'); onSaved();
  });
  const set = (k: string) => (ev: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: ev.target.value });
  const tables = Math.max(e.active_tables ?? 0, e.max_tables_month ?? 0);
  const estimate = toCents(f.monthly || '0') + toCents(f.perTable || '0') * tables;
  return (
    <Modal title={`Contrato · ${e.name}`} onClose={onClose}>
      <label>Plan<select value={f.planId} onChange={(ev) => pickPlan(ev.target.value)}>
        <option value="">Personalizado (eliges las funciones a mano)</option>
        {plans.filter((p) => p.active || p.id === f.planId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      {plan && <p className="small muted">{plan.description}</p>}
      <div className="grid cols-2">
        {!f.planId && <label>Nombre del plan<input value={f.planName} onChange={set('planName')} /></label>}
        <label>Cuota fija al mes sin IVA (€)<input inputMode="decimal" value={f.monthly} onChange={set('monthly')} /></label>
        <label>Precio por mesa activa al mes (€)<input inputMode="decimal" value={f.perTable} onChange={set('perTable')} /></label>
        <label>IVA (%)<input inputMode="decimal" value={f.vatRate} onChange={set('vatRate')} /></label>
        <label>Inicio<input type="date" value={f.startDate} onChange={set('startDate')} /></label>
        <label>Renovación<input type="date" value={f.renewalDate} onChange={set('renewalDate')} /></label>
        <label>Estado<select value={f.status} onChange={set('status')}>{Object.entries(CONTRACT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <p className="notice small">Ahora: {e.active_tables} mesas activas (máximo este mes: {e.max_tables_month}). Cuota estimada: <strong>{money(estimate)}</strong> + IVA = <strong>{money(Math.round(estimate * (1 + Number(f.vatRate.replace(',', '.') || 0) / 100)))}</strong>. Se factura el máximo de mesas activas del mes.</p>
      <h3 className="mt">Funciones {f.planId ? 'del plan' : 'contratadas'}</h3>
      <div className="row" style={{ gap: '.3rem' }}>{Object.entries(FEATURE_LABEL).map(([k, v]) => {
        const on = plan ? plan.features.includes(k) : features.includes(k);
        return <button key={k} type="button" className={`chip ${on ? 'on' : ''}`} disabled={!!plan} onClick={() => setFeatures(on ? features.filter((x) => x !== k) : [...features, k])}>{v}</button>;
      })}</div>
      {plan && <p className="small muted">Para cambiarlas, edita el plan en la pestaña «Planes» o elige «Personalizado».</p>}
      <h3 className="mt">Cobro</h3>
      <label>Forma de pago<select value={f.paymentMethod} onChange={set('paymentMethod')}>{Object.entries(PAY_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      {f.paymentMethod === 'direct_debit' && <>
        <div className="grid cols-2">
          <label>IBAN del cliente<input value={f.iban} onChange={set('iban')} placeholder={e.iban_last4 ? `Guardado: •••• ${e.iban_last4} (escribe otro para cambiarlo)` : 'ES00 0000 0000 0000 0000 0000'} autoComplete="off" /></label>
          <label>Referencia del mandato SEPA<input value={f.mandateRef} onChange={set('mandateRef')} maxLength={35} /></label>
          <label>Fecha de firma del mandato<input type="date" value={f.mandateDate} onChange={set('mandateDate')} /></label>
        </div>
        <p className="small muted">El cliente debe firmar una orden de domiciliación (mandato SEPA) con esa referencia; guárdala firmada. El IBAN se guarda cifrado y solo se muestran sus últimas cifras.</p>
      </>}
      <h3 className="mt">Datos de facturación</h3>
      <p className="small muted">Déjalos vacíos para usar los del establecimiento{e.legal_name ? ` (${e.legal_name}${e.tax_id ? `, ${e.tax_id}` : ''})` : ''}.</p>
      <div className="grid cols-2">
        <label>Razón social<input value={f.billingName} onChange={set('billingName')} /></label>
        <label>NIF / CIF<input value={f.billingTaxId} onChange={set('billingTaxId')} /></label>
        <label>Dirección fiscal<input value={f.billingAddress} onChange={set('billingAddress')} /></label>
        <label>Correo para facturas<input type="email" value={f.billingEmail} onChange={set('billingEmail')} /></label>
      </div>
      <label>Notas internas<textarea rows={2} value={f.notes} onChange={set('notes')} /></label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !f.planName.trim()} onClick={save}>Guardar contrato</button>
    </Modal>
  );
}

// ---------------- Planes ----------------
function Planes() {
  const [plans, setPlans] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const load = useCallback(() => { api<any[]>('/api/platform/plans').then(setPlans).catch(() => {}); }, []);
  useEffect(load, [load]);
  const COLORS = ['var(--green)', 'var(--terra)', '#2b2b28'];
  return (
    <div className="stack">
      <div className="spread"><h2 style={{ margin: 0 }}>Planes</h2><button className="btn primary" onClick={() => setEditing({})}>+ Nuevo plan</button></div>
      <p className="small muted">Cada plan activa sus funciones en los locales que lo tienen. Si cambias las funciones de un plan, cambian en todos sus locales; los precios ya pactados en cada contrato no se tocan.</p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {plans.map((p, k) => (
          <div key={p.id} className="card" style={{ borderTop: `6px solid ${COLORS[k % COLORS.length]}`, opacity: p.active ? 1 : .55 }}>
            <div className="spread"><h3 style={{ margin: 0 }}>{p.name}</h3><span className="small muted">{p.clients} cliente{p.clients === 1 ? '' : 's'}</span></div>
            <p className="small">{p.description}</p>
            <p style={{ fontSize: '1.15rem' }}><strong>{p.price_per_table_cents ? `${money(p.price_per_table_cents)} por mesa` : ''}{p.price_per_table_cents && p.monthly_cents ? ' + ' : ''}{p.monthly_cents ? `${money(p.monthly_cents)} al mes` : ''}{!p.price_per_table_cents && !p.monthly_cents ? 'Sin precio' : ''}</strong> <span className="small muted">+ IVA</span></p>
            <div className="row" style={{ gap: '.25rem' }}>{p.features.map((f: string) => <span key={f} className="badge">{FEATURE_LABEL[f] ?? f}</span>)}</div>
            <button className="btn small mt" onClick={() => setEditing(p)}>Editar</button>
          </div>
        ))}
      </div>
      {editing && <PlanModal p={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function PlanModal({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: p.name ?? '', description: p.description ?? '', monthly: euros(p.monthly_cents ?? 0), perTable: euros(p.price_per_table_cents ?? 0), sort: String(p.sort ?? 0), active: p.active ?? true });
  const [features, setFeatures] = useState<string[]>(p.features ?? ['menu', 'pda', 'kitchen', 'bar']);
  const { busy, error, run } = useAction();
  const save = () => run(async () => {
    if (p.id && p.clients > 0 && JSON.stringify([...features].sort()) !== JSON.stringify([...p.features].sort())
      && !confirm(`Las funciones cambiarán en los ${p.clients} locales con este plan. ¿Continuar?`)) return;
    const body = { name: f.name, description: f.description, features, monthlyCents: toCents(f.monthly || '0'), pricePerTableCents: toCents(f.perTable || '0'), sort: Number(f.sort) || 0, active: f.active };
    await api(p.id ? `/api/platform/plans/${p.id}` : '/api/platform/plans', { method: p.id ? 'PUT' : 'POST', body });
    onSaved();
  });
  return (
    <Modal title={p.id ? `Plan ${p.name}` : 'Nuevo plan'} onClose={onClose}>
      <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Descripción<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div className="grid cols-2">
        <label>Precio por mesa activa al mes (€)<input inputMode="decimal" value={f.perTable} onChange={(e) => setF({ ...f, perTable: e.target.value })} /></label>
        <label>Cuota fija al mes (€)<input inputMode="decimal" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} /></label>
        <label>Orden<input type="number" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} /></label>
      </div>
      <h3>Funciones incluidas</h3>
      <div className="row" style={{ gap: '.3rem' }}>{FEATURES.map((k) => (
        <button key={k} type="button" className={`chip ${features.includes(k) ? 'on' : ''}`} onClick={() => setFeatures(features.includes(k) ? features.filter((x) => x !== k) : [...features, k])}>{FEATURE_LABEL[k]}</button>
      ))}</div>
      <p className="small muted">Siempre incluidos: configuración y carta, mesas y QR, personal y registro de jornada, usuarios, protección de datos y copias.</p>
      {p.id && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> <span>Disponible para nuevos contratos</span></label>}
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !f.name.trim()} onClick={save}>Guardar plan</button>
    </Modal>
  );
}

function NewEstablishment({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', slug: '', adminName: '', adminUser: '', adminPass: '', adminEmail: '' });
  const { busy, error, run } = useAction();
  const toast = useToast();
  const create = () => run(async () => {
    await api('/api/platform/establishments', { body: { name: f.name, slug: f.slug, admin: { name: f.adminName, username: f.adminUser, password: f.adminPass, email: f.adminEmail.trim() || undefined } } });
    toast('Establecimiento creado'); onDone();
  });
  return (
    <Modal title="Nuevo establecimiento" onClose={onClose}>
      <div className="grid cols-2">
        <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Identificador (para el acceso del personal)<input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></label>
        <label>Nombre del administrador<input value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} /></label>
        <label>Usuario del administrador<input value={f.adminUser} onChange={(e) => setF({ ...f, adminUser: e.target.value })} /></label>
        <label>Contraseña inicial<input type="password" value={f.adminPass} onChange={(e) => setF({ ...f, adminPass: e.target.value })} /></label>
        <label>Correo del administrador (para recuperar la contraseña)<input type="email" value={f.adminEmail} onChange={(e) => setF({ ...f, adminEmail: e.target.value })} /></label>
      </div>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !f.name || !f.slug || !f.adminUser || f.adminPass.length < 8} onClick={create}>Crear establecimiento</button>
    </Modal>
  );
}

// ---------------- Facturas ----------------
function Facturas({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [period, setPeriod] = useState(thisMonth());
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<any>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => { api<any[]>(`/api/platform/invoices?year=${year}${status ? `&status=${status}` : ''}`).then(setList).catch(() => {}); }, [year, status]);
  useEffect(load, [load]);
  const refresh = () => { load(); onChange(); };
  const generate = () => run(async () => {
    const r = await api<any>('/api/platform/invoices/generate', { body: { period } });
    setResult(r); toast(r.created ? `${r.created} ${r.created === 1 ? 'factura emitida' : 'facturas emitidas'}` : 'No había cuotas pendientes de ese mes'); refresh();
  });
  const pay = (i: any) => run(async () => {
    if (i.status === 'paid') { if (!confirm(`¿Marcar ${i.code} como pendiente otra vez?`)) return; await api(`/api/platform/invoices/${i.id}/pay`, { body: { paid: false } }); }
    else await api(`/api/platform/invoices/${i.id}/pay`, { body: { paid: true, method: 'Transferencia' } });
    refresh();
  });
  const rectify = (i: any) => run(async () => {
    const reason = prompt(`Motivo de la rectificación de ${i.code} (se anula la factura entera con otra en negativo):`);
    if (!reason) return;
    const r = await api<any>(`/api/platform/invoices/${i.id}/rectify`, { body: { reason } });
    toast(`Emitida la rectificativa ${r.code}`); refresh();
  });
  const returned = (i: any) => run(async () => {
    if (!confirm(`¿El banco ha devuelto el recibo de ${i.code}? Volverá a quedar pendiente y contará como impago.`)) return;
    await api(`/api/platform/invoices/${i.id}/returned`, { body: {} }); refresh();
  });
  const csv = async () => {
    const res = await fetch(`/api/platform/invoices.csv?year=${year}`);
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `facturas-loryand-${year}.csv`; a.click();
  };
  return (
    <div className="stack">
      <div className="spread"><h2 style={{ margin: 0 }}>Facturas</h2>
        <span className="row"><button className="btn" onClick={csv}>Libro de facturas (Excel)</button><button className="btn primary" onClick={() => setCreating(true)}>+ Factura suelta</button></span></div>
      <div className="card row">
        <label style={{ margin: 0 }}>Cuotas del mes<input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        <button className="btn primary" disabled={busy || !period} onClick={generate}>Emitir cuotas de {period ? new Date(`${period}-15`).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }) : '…'}</button>
        <span className="small muted">Una factura por contrato activo. Si ya existe la de ese mes, no se repite.</span>
      </div>
      {result?.skipped?.length > 0 && <div className="notice">No se han podido facturar: {result.skipped.map((s: any) => `${s.establishment} (${s.reason})`).join('; ')}.</div>}
      <ErrorText error={error} />
      <div className="row">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Año" style={{ width: 'auto' }}>{[0, 1, 2, 3].map((k) => { const y = new Date().getFullYear() - k; return <option key={y} value={y}>{y}</option>; })}</select>
        {[['', 'Todas'], ['issued', 'Pendientes'], ['overdue', 'Vencidas'], ['paid', 'Cobradas'], ['rectified', 'Rectificadas']].map(([k, l]) => (
          <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        {list.length === 0 ? <p className="muted">No hay facturas con este filtro.</p> : (
          <table className="list">
            <thead><tr><th>Número</th><th>Fecha</th><th>Cliente</th><th>Concepto</th><th className="right">Total</th><th>Estado</th><th></th></tr></thead>
            <tbody>{list.map((i) => (
              <tr key={i.id}>
                <td><code>{i.code}</code></td>
                <td className="small">{fmtDate(i.issue_date)}</td>
                <td>{i.establishment}<div className="small muted">{i.customer.taxId}</div></td>
                <td className="small">{i.lines[0]?.description}{i.lines.length > 1 && ` y ${i.lines.length - 1} más`}</td>
                <td className="right"><strong>{money(i.total_cents)}</strong></td>
                <td>{i.kind === 'rectifying' ? <span className="badge grey">Rectificativa</span>
                  : i.status === 'paid' ? <span className="badge">Cobrada</span>
                  : i.status === 'rectified' ? <span className="badge grey">Rectificada</span>
                  : i.returned_at ? <span className="badge danger">Devuelto {fmtDate(i.returned_at)}</span>
                  : i.remittance_id ? <span className="badge warn">En remesa</span>
                  : i.overdue ? <span className="badge danger">Vencida {fmtDate(i.due_date)}</span> : <span className="badge warn">Vence {fmtDate(i.due_date)}</span>}</td>
                <td className="right"><div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                  <a className="btn small" href={`/gestion/factura/${i.id}`}>Ver</a>
                  {i.kind === 'invoice' && i.status !== 'rectified' && <button className="btn small" disabled={busy} onClick={() => pay(i)}>{i.status === 'paid' ? 'Deshacer cobro' : 'Cobrada'}</button>}
                  {i.kind === 'invoice' && (i.remittance_id || i.paid_method === 'Domiciliación SEPA') && <button className="btn small ghost danger" disabled={busy} onClick={() => returned(i)}>Devuelto</button>}
                  {i.kind === 'invoice' && i.status !== 'rectified' && <button className="btn small ghost" disabled={busy} onClick={() => rectify(i)}>Rectificar</button>}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Remesas onChange={refresh} />
      {creating && <NewInvoice onClose={() => setCreating(false)} onDone={() => { setCreating(false); refresh(); }} />}
    </div>
  );
}

function NewInvoice({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [clients, setClients] = useState<any[]>([]);
  const [est, setEst] = useState('');
  const [lines, setLines] = useState([{ description: '', qty: '1', price: '', vatRate: '21' }]);
  const { busy, error, run } = useAction();
  const toast = useToast();
  useEffect(() => { api<any[]>('/api/platform/clients').then(setClients).catch(() => {}); }, []);
  const parsed = lines.map((l) => ({ description: l.description.trim(), qty: Number(l.qty.replace(',', '.')) || 0, unitCents: toCents(l.price || '0'), vatRate: Number(l.vatRate.replace(',', '.')) || 0 }));
  const base = parsed.reduce((s, l) => s + Math.round(l.qty * l.unitCents), 0);
  const vat = parsed.reduce((s, l) => s + Math.round((Math.round(l.qty * l.unitCents) * l.vatRate) / 100), 0);
  const upd = (k: number, field: string, v: string) => setLines(lines.map((l, j) => (j === k ? { ...l, [field]: v } : l)));
  const save = () => run(async () => {
    const r = await api<any>('/api/platform/invoices', { body: { establishmentId: est, lines: parsed.filter((l) => l.description) } });
    toast(`Emitida la factura ${r.code}`); onDone();
  });
  return (
    <Modal title="Factura suelta" onClose={onClose}>
      <label>Cliente<select value={est} onChange={(e) => setEst(e.target.value)}><option value="">Elige cliente…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      {lines.map((l, k) => (
        <div key={k} className="grid" style={{ gridTemplateColumns: '1fr 70px 100px 70px auto', gap: '.4rem', alignItems: 'end' }}>
          <label style={{ margin: 0 }}>{k === 0 && 'Concepto'}<input value={l.description} onChange={(e) => upd(k, 'description', e.target.value)} placeholder="Instalación, impresora, formación…" /></label>
          <label style={{ margin: 0 }}>{k === 0 && 'Cant.'}<input inputMode="decimal" value={l.qty} onChange={(e) => upd(k, 'qty', e.target.value)} /></label>
          <label style={{ margin: 0 }}>{k === 0 && 'Precio sin IVA'}<input inputMode="decimal" value={l.price} onChange={(e) => upd(k, 'price', e.target.value)} /></label>
          <label style={{ margin: 0 }}>{k === 0 && 'IVA %'}<input inputMode="decimal" value={l.vatRate} onChange={(e) => upd(k, 'vatRate', e.target.value)} /></label>
          <button className="btn small ghost" aria-label="Quitar línea" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== k))}>×</button>
        </div>
      ))}
      <button className="btn small mt" onClick={() => setLines([...lines, { description: '', qty: '1', price: '', vatRate: '21' }])}>+ Línea</button>
      <p className="right mt">Base {money(base)} · IVA {money(vat)} · <strong>Total {money(base + vat)}</strong></p>
      <p className="small muted">Una factura emitida no se puede borrar ni modificar: si hay un error, se rectifica.</p>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !est || base <= 0 || parsed.some((l) => !l.description && l.unitCents)} onClick={save}>Emitir factura</button>
    </Modal>
  );
}

// ---------------- Remesas SEPA ----------------
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

function Remesas({ onChange }: { onChange: () => void }) {
  const [cands, setCands] = useState<any[]>([]);
  const [rems, setRems] = useState<any[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [date, setDate] = useState(inDays(3));
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => {
    api<any[]>('/api/platform/remittances/candidates').then((c) => { setCands(c); setSel(c.filter((x) => x.ready).map((x) => x.id)); }).catch(() => {});
    api<any[]>('/api/platform/remittances').then(setRems).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const download = async (id: string, name: string) => {
    const res = await fetch(`/api/platform/remittances/${id}/xml`);
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `${name}.xml`; a.click();
  };
  const create = () => run(async () => {
    const r = await api<any>('/api/platform/remittances', { body: { invoiceIds: sel, collectionDate: date } });
    toast(`Remesa ${r.msgId}: ${r.count} ${r.count === 1 ? 'recibo' : 'recibos'}, ${money(r.totalCents)}`); await download(r.id, r.msgId); load(); onChange();
  });
  const collected = (r: any) => run(async () => {
    if (!confirm(`¿El banco ha abonado la remesa ${r.msg_id}? Sus facturas quedarán cobradas (las devueltas las marcas después una a una).`)) return;
    await api(`/api/platform/remittances/${r.id}/collected`, { body: {} }); load(); onChange();
  });
  const total = cands.filter((c) => sel.includes(c.id)).reduce((t, c) => t + c.total_cents, 0);
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Remesas de recibos SEPA</h3>
      <p className="small muted">Facturas pendientes de los clientes con domiciliación. Genera el fichero, súbelo a la banca electrónica de tu banco («Adeudos directos SEPA · CORE» o «remesas de recibos») y, cuando el banco lo abone, márcala como cobrada.</p>
      {cands.length === 0 ? <p className="muted">No hay recibos pendientes de remesar.</p> : (
        <table className="list">
          <tbody>{cands.map((c) => (
            <tr key={c.id} style={c.ready ? undefined : { opacity: .6 }}>
              <td><input type="checkbox" aria-label={`Incluir ${c.code}`} disabled={!c.ready} checked={sel.includes(c.id)} onChange={() => setSel(sel.includes(c.id) ? sel.filter((x) => x !== c.id) : [...sel, c.id])} /></td>
              <td><code>{c.code}</code></td><td>{c.establishment}{c.returned_at && <span className="badge danger" style={{ marginLeft: '.35rem' }}>Devuelto antes</span>}</td>
              <td className="small">{c.ready ? `IBAN •••• ${c.iban_last4} · ${c.mandate_ref}` : 'Falta IBAN o mandato en el contrato'}</td>
              <td className="right">{money(c.total_cents)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {cands.length > 0 && (
        <div className="row">
          <label style={{ margin: 0 }}>Fecha de cargo<input type="date" min={inDays(1)} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <button className="btn primary" disabled={busy || !sel.length} onClick={create}>Generar remesa ({sel.length} · {money(total)}) y descargar fichero</button>
        </div>
      )}
      <ErrorText error={error} />
      {rems.length > 0 && (
        <table className="list">
          <thead><tr><th>Remesa</th><th>Cargo</th><th className="right">Recibos</th><th className="right">Total</th><th>Estado</th><th></th></tr></thead>
          <tbody>{rems.map((r) => (
            <tr key={r.id}>
              <td><code>{r.msg_id}</code></td><td className="small">{fmtDate(r.collection_date)}</td><td className="right">{r.count}</td><td className="right">{money(r.total_cents)}</td>
              <td>{r.status === 'collected' ? <span className="badge">Cobrada</span> : <span className="badge warn">Enviada</span>}</td>
              <td className="right"><div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                <button className="btn small" onClick={() => download(r.id, r.msg_id)}>Fichero</button>
                {r.status !== 'collected' && <button className="btn small" disabled={busy} onClick={() => collected(r)}>Cobrada</button>}
              </div></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

// ---------------- Incidencias ----------------
function Incidencias({ onChange }: { onChange: () => void }) {
  const [filter, setFilter] = useState('active');
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => { api<any[]>(`/api/platform/tickets?status=${filter}`).then(setList).catch(() => {}); }, [filter]);
  useEffect(load, [load]);
  return (
    <div className="stack">
      <h2 style={{ margin: 0 }}>Incidencias</h2>
      <div className="row">{[['active', 'Sin resolver'], ['open', 'Abiertas'], ['in_progress', 'En curso'], ['waiting', 'Esperando al cliente'], ['resolved', 'Resueltas']].map(([k, l]) => (
        <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>
      ))}</div>
      <div className="card" style={{ overflowX: 'auto' }}>
        {list.length === 0 ? <p className="muted">No hay incidencias con este filtro.</p> : (
          <table className="list">
            <thead><tr><th>Nº</th><th>Incidencia</th><th>Cliente</th><th>Prioridad</th><th>Estado</th><th>Actualizada</th></tr></thead>
            <tbody>{list.map((t) => (
              <tr key={t.id} onClick={() => setOpen(t.id)} style={{ cursor: 'pointer' }}>
                <td>#{t.number}</td>
                <td>{t.unread_gestor && <span className="badge terra" style={{ marginRight: '.35rem' }}>Nuevo</span>}<strong>{t.title}</strong><div className="small muted">{TICKET_CATEGORY[t.category]} · {t.created_by}</div></td>
                <td>{t.establishment}</td>
                <td>{t.priority === 'urgent' || t.priority === 'high' ? <span className="badge danger">{TICKET_PRIORITY[t.priority]}</span> : TICKET_PRIORITY[t.priority]}</td>
                <td>{TICKET_STATUS[t.status]}</td>
                <td className="small">{new Date(t.updated_at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {open && <TicketThread id={open} side="gestor" onClose={() => { setOpen(null); load(); onChange(); }} />}
    </div>
  );
}

/** Conversación de una incidencia, desde el lado del gestor o del cliente. */
export function TicketThread({ id, side, onClose }: { id: string; side: 'gestor' | 'client'; onClose: () => void }) {
  const base = side === 'gestor' ? '/api/platform/tickets' : '/api/support/tickets';
  const [t, setT] = useState<any>(null);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('waiting');
  const { busy, error, run } = useAction();
  useEffect(() => { api(`${base}/${id}`).then(setT).catch(() => {}); }, [base, id]);
  const send = () => run(async () => {
    setT(await api(`${base}/${id}/messages`, { body: side === 'gestor' ? { body, status } : { body } })); setBody('');
  });
  const patch = (b: object) => run(async () => setT(await api(`${base}/${id}`, { method: 'PATCH', body: b })));
  if (!t) return null;
  return (
    <Modal title={`#${t.number} · ${t.title}`} onClose={onClose}>
      <p className="small muted">{t.establishment} · {TICKET_CATEGORY[t.category]} · abierta por {t.created_by} el {new Date(t.created_at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</p>
      {side === 'gestor' && (
        <div className="row">
          <label style={{ margin: 0 }}>Estado<select value={t.status} onChange={(e) => patch({ status: e.target.value })}>{Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label style={{ margin: 0 }}>Prioridad<select value={t.priority} onChange={(e) => patch({ priority: e.target.value })}>{Object.entries(TICKET_PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
      )}
      {side === 'client' && <p><span className="badge">{TICKET_STATUS[t.status]}</span></p>}
      <div className="stack" style={{ maxHeight: 340, overflowY: 'auto', margin: '.8rem 0', gap: '.5rem' }}>
        {t.messages.map((m: any) => {
          const mine = (m.author_kind === 'gestor') === (side === 'gestor');
          return (
            <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', background: mine ? 'var(--green-soft)' : 'var(--paper)', border: '1px solid var(--line)', borderRadius: 10, padding: '.55rem .75rem' }}>
              <div className="small muted">{m.author_name} · {new Date(m.created_at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
            </div>
          );
        })}
      </div>
      <label>{side === 'gestor' ? 'Respuesta al cliente' : 'Añadir un mensaje'}<textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      {side === 'gestor' && <label>Después de responder, dejar como<select value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
      {side === 'client' && t.status === 'resolved' && <p className="small muted">Si escribes, la incidencia se vuelve a abrir.</p>}
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !body.trim()} onClick={send}>Enviar</button>
    </Modal>
  );
}

// ---------------- Emisor ----------------
function Emisor() {
  const [f, setF] = useState<any>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  useEffect(() => { api('/api/platform/billing-settings').then(setF).catch(() => {}); }, []);
  if (!f) return <p className="muted">Cargando…</p>;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = () => run(async () => { setF(await api('/api/platform/billing-settings', { method: 'PUT', body: { ...f, paymentDays: Number(f.paymentDays) } })); toast('Datos de facturación guardados'); });
  return (
    <div className="card stack" style={{ maxWidth: 760 }}>
      <h2 style={{ margin: 0 }}>Datos de Loryand como emisor</h2>
      <p className="small muted">Aparecen en todas las facturas. Cada factura guarda una copia de estos datos: cambiarlos no altera las ya emitidas.</p>
      <div className="grid cols-2">
        <label>Razón social o nombre<input value={f.name} onChange={set('name')} /></label>
        <label>NIF<input value={f.taxId} onChange={set('taxId')} /></label>
        <label>Dirección<input value={f.address} onChange={set('address')} /></label>
        <label>Código postal<input value={f.postalCode} onChange={set('postalCode')} /></label>
        <label>Localidad<input value={f.city} onChange={set('city')} /></label>
        <label>Provincia<input value={f.province} onChange={set('province')} /></label>
        <label>Correo<input type="email" value={f.email} onChange={set('email')} /></label>
        <label>Teléfono<input value={f.phone} onChange={set('phone')} /></label>
        <label>IBAN (transferencias y remesas)<input value={f.iban} onChange={set('iban')} /></label>
        <label>BIC del banco (opcional)<input value={f.bic} onChange={set('bic')} /></label>
        <label>Identificador de acreedor SEPA<input value={f.creditorId} onChange={set('creditorId')} placeholder="Vacío: se calcula con tu NIF (sufijo 000)" /></label>
        <label>Días para pagar<input type="number" min={0} max={120} value={f.paymentDays} onChange={set('paymentDays')} /></label>
        <label>Serie de facturas<input value={f.series} onChange={set('series')} /></label>
        <label>Serie de rectificativas<input value={f.rectifyingSeries} onChange={set('rectifyingSeries')} /></label>
      </div>
      <label>Texto al pie de la factura (opcional)<textarea rows={2} value={f.footer} onChange={set('footer')} placeholder="Inscrita en el Registro Mercantil de…" /></label>
      <ErrorText error={error} />
      <button className="btn primary" disabled={busy} onClick={save}>Guardar</button>
    </div>
  );
}
