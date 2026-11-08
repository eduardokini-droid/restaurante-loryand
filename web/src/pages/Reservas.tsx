import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ZONE_LABEL, money, today, toCents } from '../lib/format';
import { useSession } from '../lib/session';
import { useLive } from '../lib/realtime';
import { ErrorText, Modal, useAction, useToast } from '../components/ui';

const STATUS: Record<string, [string, string]> = {
  requested: ['Solicitud', 'warn'], confirmed: ['Confirmada', ''], seated: ['Sentados', 'terra'],
  finished: ['Finalizada', 'grey'], cancelled: ['Cancelada', 'grey'], no_show: ['No presentado', 'danger'],
};
const DEPOSIT: Record<string, string> = { none: '', pending: 'Fianza pendiente', paid: 'Fianza pagada', refunded: 'Fianza devuelta' };

export default function Reservas() {
  const { me } = useSession();
  const [date, setDate] = useState(today());
  const [data, setData] = useState<{ settings: any; reservations: any[] } | null>(null);
  const [tables, setTables] = useState<{ id: string; label: string; seats: number; zone: string }[]>([]);
  const [form, setForm] = useState<any | null>(null);
  const [settings, setSettings] = useState(false);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const load = useCallback(() => { api(`/api/reservations?date=${date}`).then(setData).catch(() => {}); }, [date]);
  useEffect(load, [load]);
  useEffect(() => { api('/api/service/floor').then((f) => setTables(f.tables)).catch(() => {}); }, []);
  useLive(load, ['tables']);

  const patch = (r: any, body: object, msg?: string) => run(async () => { await api(`/api/reservations/${r.id}`, { method: 'PATCH', body }); if (msg) toast(msg); load(); });
  const shift = (d: number) => { const x = new Date(date); x.setDate(x.getDate() + d); setDate(x.toISOString().slice(0, 10)); };
  const publicUrl = `${location.origin}/reservar/${me?.establishment?.slug}`;
  const list = data?.reservations ?? [];
  const covers = list.filter((r) => ['confirmed', 'seated'].includes(r.status)).reduce((s, r) => s + r.party_size, 0);

  return (
    <div className="stack">
      <div className="spread">
        <h1>Reservas</h1>
        <span className="row">
          <button className="btn" onClick={() => setSettings(true)}>Turnos y política</button>
          <button className="btn primary" onClick={() => setForm({ name: '', phone: '', partySize: 2, date, time: '21:00', notes: '', zonePref: '', tableIds: [] })}>+ Nueva reserva</button>
        </span>
      </div>
      <div className="card row">
        <button className="btn small" onClick={() => shift(-1)}>←</button>
        <input type="date" style={{ maxWidth: 180 }} value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn small" onClick={() => shift(1)}>→</button>
        <button className="btn small ghost" onClick={() => setDate(today())}>Hoy</button>
        <span className="muted small">{list.length} reservas · {covers} comensales confirmados</span>
      </div>
      <p className="small muted">Formulario público para tus clientes: <a href={publicUrl} target="_blank" rel="noreferrer">{publicUrl}</a> · Una solicitud no es una reserva confirmada hasta que la confirmes.</p>
      <ErrorText error={error} />
      <div className="card" style={{ overflowX: 'auto' }}>
        {list.length === 0 && <p className="muted">No hay reservas este día.</p>}
        {list.length > 0 && (
          <table className="list">
            <thead><tr><th>Hora</th><th>Cliente</th><th>Pers.</th><th>Mesa</th><th>Estado</th><th></th></tr></thead>
            <tbody>{list.map((r) => (
              <tr key={r.id} style={['cancelled', 'no_show', 'finished'].includes(r.status) ? { opacity: .55 } : undefined}>
                <td><strong>{r.time}</strong>{r.overdue && <div className="badge danger">Pasado el margen</div>}</td>
                <td>{r.name}<div className="small muted">{r.phone}{r.source === 'public' && ' · web'}</div>{r.notes && <div className="small">{r.notes}</div>}</td>
                <td>{r.party_size}{r.zone_pref && <div className="small muted">{ZONE_LABEL[r.zone_pref]}</div>}</td>
                <td>
                  <select style={{ minWidth: 110 }} value={r.table_ids[0] ?? ''} disabled={busy || ['finished', 'cancelled', 'no_show'].includes(r.status)}
                    onChange={(e) => patch(r, { tableIds: e.target.value ? [e.target.value] : [] })}>
                    <option value="">Sin mesa</option>
                    {tables.map((t) => <option key={t.id} value={t.id}>{t.label} ({t.seats} pl.)</option>)}
                  </select>
                </td>
                <td><span className={`badge ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                  {r.deposit_cents > 0 && <div className="small">{DEPOSIT[r.deposit_status]} · {money(r.deposit_cents)}</div>}</td>
                <td className="right"><div className="row" style={{ gap: '.3rem', justifyContent: 'flex-end' }}>
                  {r.deposit_cents > 0 && r.deposit_status === 'pending' && <button className="btn small" disabled={busy} onClick={() => patch(r, { depositStatus: 'paid' }, 'Fianza registrada como pagada')}>Fianza pagada</button>}
                  {r.status === 'requested' && <button className="btn small primary" disabled={busy} onClick={() => patch(r, { status: 'confirmed' }, 'Reserva confirmada')}>Confirmar</button>}
                  {r.status === 'confirmed' && <button className="btn small primary" disabled={busy} onClick={() => patch(r, { status: 'seated' }, 'Grupo sentado')}>Sentar</button>}
                  {r.status === 'seated' && <button className="btn small" disabled={busy} onClick={() => patch(r, { status: 'finished' })}>Finalizar</button>}
                  {['requested', 'confirmed'].includes(r.status) && <>
                    <button className="btn small ghost" disabled={busy} onClick={() => confirm('¿Marcar como no presentado?') && patch(r, { status: 'no_show' })}>No vino</button>
                    <button className="btn small ghost" disabled={busy} onClick={() => confirm('¿Cancelar la reserva?') && patch(r, { status: 'cancelled' })}>Cancelar</button>
                  </>}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <p className="small muted">Los recordatorios por correo o WhatsApp requieren conectar un proveedor: el programa todavía no envía avisos automáticos. El estado «Lista de espera» de la cola presencial es independiente de las reservas.</p>
      {form && <ReservationForm initial={form} tables={tables} onClose={() => setForm(null)} onDone={() => { setForm(null); load(); }} />}
      {settings && data && <SettingsForm initial={data.settings} onClose={() => setSettings(false)} onDone={() => { setSettings(false); load(); }} />}
    </div>
  );
}

function ReservationForm({ initial, tables, onClose, onDone }: { initial: any; tables: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState(initial);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const save = () => run(async () => {
    const r = await api('/api/reservations', { body: { ...f, zonePref: f.zonePref || null } });
    toast(r.status === 'requested' && r.deposit_cents > 0 ? `Reserva registrada: pendiente de fianza (${money(r.deposit_cents)})` : 'Reserva confirmada');
    onDone();
  });
  return (
    <Modal title="Nueva reserva" onClose={onClose}>
      <div className="grid cols-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Teléfono<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        <label>Fecha<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label>Hora<input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></label>
        <label>Comensales<input type="number" min={1} value={f.partySize} onChange={(e) => setF({ ...f, partySize: Number(e.target.value) })} /></label>
        <label>Mesa<select value={f.tableIds[0] ?? ''} onChange={(e) => setF({ ...f, tableIds: e.target.value ? [e.target.value] : [] })}>
          <option value="">Asignar más tarde</option>{tables.map((t) => <option key={t.id} value={t.id}>{t.label} ({t.seats} pl.)</option>)}</select></label>
      </div>
      <label>Notas (alergias, celebración, trona…)<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy || !f.name.trim()} onClick={save}>Guardar reserva</button>
    </Modal>
  );
}

function SettingsForm({ initial, onClose, onDone }: { initial: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ ...initial, deposit: (initial.depositPerPersonCents / 100).toFixed(2) });
  const { busy, error, run } = useAction();
  const save = () => run(async () => {
    const { deposit, ...rest } = f;
    await api('/api/reservations/settings', { method: 'PUT', body: { ...rest, depositPerPersonCents: toCents(deposit || '0') } });
    onDone();
  });
  const win = (k: 'lunch' | 'dinner', label: string) => (
    <div className="row">
      <label className="check" style={{ margin: 0, minWidth: 90 }}><input type="checkbox" checked={!!f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked ? { start: k === 'lunch' ? '13:00' : '20:00', end: k === 'lunch' ? '15:30' : '22:30' } : null })} /> {label}</label>
      {f[k] && <>
        <input type="time" style={{ maxWidth: 130 }} value={f[k].start} onChange={(e) => setF({ ...f, [k]: { ...f[k], start: e.target.value } })} /> a
        <input type="time" style={{ maxWidth: 130 }} value={f[k].end} onChange={(e) => setF({ ...f, [k]: { ...f[k], end: e.target.value } })} />
      </>}
    </div>
  );
  return (
    <Modal title="Turnos y política" onClose={onClose}>
      <div className="stack">
        {win('lunch', 'Comida')}
        {win('dinner', 'Cena')}
      </div>
      <div className="grid cols-2 mt" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label>Duración habitual (min)<input type="number" value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: Number(e.target.value) })} /></label>
        <label>Margen de espera antes de liberar (min)<input type="number" value={f.graceMin} onChange={(e) => setF({ ...f, graceMin: Number(e.target.value) })} /></label>
        <label>Fianza por persona (€)<input inputMode="decimal" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} /></label>
        <label>Exigir fianza desde (personas, 0 = nunca)<input type="number" value={f.depositFromParty} onChange={(e) => setF({ ...f, depositFromParty: Number(e.target.value) })} /></label>
        <label>Máximo de personas en la web<input type="number" value={f.maxPartyOnline} onChange={(e) => setF({ ...f, maxPartyOnline: Number(e.target.value) })} /></label>
      </div>
      <label>Política de cancelación<textarea rows={2} value={f.cancellationPolicy} onChange={(e) => setF({ ...f, cancellationPolicy: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={f.publicEnabled} onChange={(e) => setF({ ...f, publicEnabled: e.target.checked })} /> Aceptar solicitudes desde el formulario público</label>
      <ErrorText error={error} />
      <button className="btn primary block" disabled={busy} onClick={save}>Guardar configuración</button>
    </Modal>
  );
}
