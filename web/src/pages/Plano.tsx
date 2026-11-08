import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { PHYSICAL_LABEL, ZONE_LABEL, money } from '../lib/format';
import { useFloor, TableControls, type FloorTable } from '../components/Floor';
import { AccountView } from '../components/AccountView';
import { ErrorText, Modal, useAction } from '../components/ui';

type T = FloorTable & { pos_x: number | null; pos_y: number | null; shape: string; join_group: string | null };

const STATE_COLOR: Record<string, string> = {
  free: 'var(--paper)', occupied: 'var(--green-soft)', paid_occupied: '#fbefd5', dirty: 'var(--line)',
};

/** Posición por defecto en cuadrícula para las mesas que aún no se han colocado. */
const autoPos = (i: number) => ({ x: 8 + (i % 6) * 15, y: 12 + Math.floor(i / 6) * 22 });

/** Plano del local (capítulo 10): colocar mesas arrastrándolas y ver su estado. */
export default function Plano() {
  const { floor, reload } = useFloor();
  const [zone, setZone] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [open, setOpen] = useState<T | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const { error, run } = useAction();

  if (!floor) return <p className="muted">Cargando plano…</p>;
  const tables = floor.tables as T[];
  const zones = [...new Set(tables.map((t) => t.zone))];
  const current = zone ?? zones[0];
  const inZone = tables.filter((t) => t.zone === current);
  const pos = (t: T, i: number) => (drag?.id === t.id ? { x: drag.x, y: drag.y } : t.pos_x != null && t.pos_y != null ? { x: t.pos_x, y: t.pos_y } : autoPos(i));

  const toPercent = (e: React.PointerEvent) => {
    const r = board.current!.getBoundingClientRect();
    return {
      x: Math.round(Math.min(95, Math.max(2, ((e.clientX - r.left) / r.width) * 100))),
      y: Math.round(Math.min(92, Math.max(4, ((e.clientY - r.top) / r.height) * 100))),
    };
  };
  const save = (t: T, body: object) => run(async () => { await api(`/api/admin/tables/${t.id}`, { method: 'PATCH', body }); reload(); });
  const placeAll = () => run(async () => {
    await Promise.all(inZone.map((t, i) => (t.pos_x == null ? api(`/api/admin/tables/${t.id}`, { method: 'PATCH', body: { posX: autoPos(i).x, posY: autoPos(i).y } }) : null)));
    reload();
  });
  const openTable = open && tables.find((t) => t.id === open.id);

  return (
    <div className="stack">
      <div className="spread">
        <h1>Plano del local</h1>
        <span className="row">
          {edit && <button className="btn small" onClick={placeAll}>Guardar posiciones automáticas</button>}
          <button className={`btn ${edit ? 'primary' : ''}`} onClick={() => setEdit(!edit)}>{edit ? 'Terminar de colocar' : 'Colocar mesas'}</button>
        </span>
      </div>
      <div className="chips">{zones.map((z) => <button key={z} className={`chip ${z === current ? 'on' : ''}`} onClick={() => setZone(z)}>{ZONE_LABEL[z] ?? z}</button>)}</div>
      {edit && <p className="notice small">Arrastra cada mesa a su sitio real. Haz los cambios con el servicio tranquilo y comprueba que cada mesa corresponde a la real. Toca una mesa para cambiar su forma.</p>}
      <ErrorText error={error} />
      <div ref={board} className="card" style={{ position: 'relative', height: 'min(70vh, 560px)', padding: 0, overflow: 'hidden', touchAction: edit ? 'none' : 'auto',
        backgroundImage: edit ? 'linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)' : undefined, backgroundSize: '5% 5%' }}>
        {inZone.map((t, i) => {
          const p = pos(t, i);
          const w = t.shape === 'rect' ? 15 : 10;
          const pending = t.total_cents - t.paid_cents;
          return (
            <div key={t.id}
              onPointerDown={(e) => { if (!edit) return; (e.target as HTMLElement).setPointerCapture(e.pointerId); setDrag({ id: t.id, ...toPercent(e) }); }}
              onPointerMove={(e) => { if (drag?.id === t.id) setDrag({ id: t.id, ...toPercent(e) }); }}
              onPointerUp={() => { if (drag?.id === t.id) { save(t, { posX: drag.x, posY: drag.y }); setDrag(null); } }}
              onClick={() => { if (!edit) setOpen(t); }}
              title={`${t.label} · ${t.seats} plazas · ${PHYSICAL_LABEL[t.physical_state]}`}
              style={{
                position: 'absolute', left: `${p.x}%`, top: `${p.y}%`, transform: 'translate(-50%, -50%)',
                width: `${w}%`, minWidth: t.shape === 'rect' ? 110 : 74, aspectRatio: t.shape === 'rect' ? '2 / 1' : '1 / 1',
                borderRadius: t.shape === 'round' ? '50%' : 12, background: STATE_COLOR[t.physical_state],
                border: `2px solid ${t.requests.length || t.ready ? 'var(--terra)' : t.physical_state === 'free' ? 'var(--line)' : 'var(--green)'}`,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: edit ? 'grab' : 'pointer',
                userSelect: 'none', boxShadow: drag?.id === t.id ? '0 6px 18px rgba(0,0,0,.2)' : 'var(--shadow)', fontSize: '.8rem', color: 'var(--ink)',
              }}>
              <strong style={{ fontSize: '1.1rem' }}>{t.label}</strong>
              <span className="muted">{t.seats} pl.{t.join_group && ` · ${t.join_group}`}</span>
              {!edit && pending > 0 && <span>{money(pending)}</span>}
              {!edit && t.ready > 0 && <span className="badge terra" style={{ fontSize: '.65rem' }}>{t.ready} listo</span>}
              {edit && (
                <select value={t.shape} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => save(t, { shape: e.target.value })}
                  style={{ fontSize: '.7rem', padding: '0 .2rem', width: 'auto', marginTop: 2 }}>
                  <option value="square">Cuadrada</option><option value="round">Redonda</option><option value="rect">Alargada</option>
                </select>
              )}
            </div>
          );
        })}
      </div>
      <div className="row small muted">
        {Object.entries(PHYSICAL_LABEL).map(([k, v]) => <span key={k} className="row" style={{ gap: '.3rem' }}><span style={{ width: 14, height: 14, borderRadius: 4, background: STATE_COLOR[k], border: '1px solid var(--line)', display: 'inline-block' }} />{v}</span>)}
        <span>· Borde naranja: platos listos o aviso del cliente</span>
      </div>
      {openTable && !edit && (
        <Modal title={`Mesa ${openTable.label}`} onClose={() => setOpen(null)}>
          {openTable.account_id ? <AccountView accountId={openTable.account_id} onClosed={reload} /> : <p className="muted">Sin cuenta abierta.</p>}
          <div className="mt"><TableControls table={openTable} onChanged={reload} /></div>
        </Modal>
      )}
    </div>
  );
}
