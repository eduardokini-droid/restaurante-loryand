import { sql, type Tx } from '../db.js';

type Q = typeof sql | Tx;

/** Unidad asignable: una mesa suelta o un grupo de mesas unidas (suman plazas). */
export interface Unit {
  key: string; tableIds: string[]; labels: string[]; seats: number; zone: string;
  state: 'free' | 'occupied' | 'paid_occupied' | 'dirty' | 'blocked';
  occupiedSince: string | null; blockedReason?: string;
}

export interface WaitGroup {
  id: string; name: string; party_size: number; phone: string; zone_pref: string | null; status: string;
  table_ids: string[]; created_at: string; notified_at: string | null;
}

const DEFAULT_STAY_MIN = 75;
const CLEANING_MIN = 5;
const LEAVING_MIN = 10;
const RESERVATION_WINDOW_MIN = 120;

export async function loadUnits(q: Q, establishmentId: string): Promise<Unit[]> {
  const rows = await q`
    select t.id, t.label, t.seats, t.zone, t.physical_state, t.join_group,
           exists (select 1 from accounts a where a.table_id = t.id and a.status = 'open'
                   and exists (select 1 from orders o join order_items i on i.order_id = o.id where o.account_id = a.id and i.status <> 'cancelled')) as has_account,
           exists (select 1 from waitlist w where w.establishment_id = t.establishment_id and w.status = 'notified' and t.id = any(w.table_ids)) as promised,
           exists (select 1 from reservations r where r.establishment_id = t.establishment_id and t.id = any(r.table_ids)
                   and r.status = 'confirmed' and r.starts_at between now() - interval '15 minutes' and now() + make_interval(mins => ${RESERVATION_WINDOW_MIN})) as reserved,
           (select started_at from table_occupancy o where o.table_id = t.id and o.ended_at is null) as occupied_since
    from tables t
    where t.establishment_id = ${establishmentId} and t.active
    order by length(t.label), t.label`;
  const groups = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) {
    const key = r.join_group ? `g:${r.join_group}` : r.id;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const rank = { free: 0, dirty: 1, paid_occupied: 2, occupied: 3 } as const;
  return [...groups.entries()].map(([key, ts]) => {
    // El estado de una unión es el de su mesa "más ocupada".
    const worst = ts.reduce((w, t) => (rank[t.physical_state as keyof typeof rank] > rank[w.physical_state as keyof typeof rank] ? t : w), ts[0]);
    let state: Unit['state'] = worst.physical_state;
    let blockedReason: string | undefined;
    if (state === 'free' && ts.some((t) => t.has_account)) { state = 'occupied'; }
    if (state === 'free' && ts.some((t) => t.promised)) { state = 'blocked'; blockedReason = 'Asignada a un grupo avisado'; }
    if (state === 'free' && ts.some((t) => t.reserved)) { state = 'blocked'; blockedReason = 'Reserva en las próximas dos horas'; }
    const since = ts.map((t) => t.occupied_since).filter(Boolean).sort()[0] ?? null;
    return {
      key, tableIds: ts.map((t) => t.id), labels: ts.map((t) => t.label), seats: ts.reduce((s, t) => s + t.seats, 0),
      zone: ts[0].zone, state, occupiedSince: since, blockedReason,
    };
  });
}

/** Duración media de ocupación en los últimos 60 días, para estimar la espera. */
export async function averageStay(q: Q, establishmentId: string): Promise<{ minutes: number; samples: number }> {
  const [r] = await q`
    select count(*)::int as n, avg(extract(epoch from (o.ended_at - o.started_at)) / 60)::float as avg
    from table_occupancy o join tables t on t.id = o.table_id
    where t.establishment_id = ${establishmentId} and o.ended_at is not null
      and o.started_at > now() - interval '60 days'
      and o.ended_at - o.started_at between interval '10 minutes' and interval '5 hours'`;
  return r.n >= 5 ? { minutes: Math.round(r.avg), samples: r.n } : { minutes: DEFAULT_STAY_MIN, samples: r.n };
}

const fits = (u: Unit, g: WaitGroup) => u.seats >= g.party_size && (!g.zone_pref || g.zone_pref === u.zone);
/** Se busca la capacidad más ajustada; a igualdad, la que antes se liberó. */
const bySeats = (a: Unit, b: Unit) => a.seats - b.seats;

export interface Proposal { groupId: string; unit: Unit | null; estimateMin: number | null }

/**
 * Regla de asignación (capítulo 20): se recorre la cola por orden de llegada y se propone a cada grupo
 * la mesa libre más ajustada que le quepa y respete su zona. Un grupo grande que no cabe conserva
 * su antigüedad, pero no bloquea a los siguientes. No se unen mesas automáticamente.
 *
 * Mejora respecto a la versión anterior: para quien no tiene mesa se estima la espera a partir de
 * cuándo suele liberarse cada mesa ocupada (duración media real del local).
 */
export function propose(units: Unit[], groups: WaitGroup[], avgStayMin: number, now = Date.now()): Proposal[] {
  const free = units.filter((u) => u.state === 'free');
  const expected = units
    .filter((u) => u.state !== 'free' && u.state !== 'blocked')
    .map((u) => {
      let at: number;
      if (u.state === 'dirty') at = now + CLEANING_MIN * 60_000;
      else if (u.state === 'paid_occupied') at = now + (LEAVING_MIN + CLEANING_MIN) * 60_000;
      else {
        const since = u.occupiedSince ? new Date(u.occupiedSince).getTime() : now;
        at = Math.max(since + avgStayMin * 60_000, now + LEAVING_MIN * 60_000) + CLEANING_MIN * 60_000;
      }
      return { unit: u, at };
    })
    .sort((a, b) => a.at - b.at);

  const out: Proposal[] = [];
  for (const g of groups) {
    if (g.status !== 'waiting') continue;
    const candidates = free.filter((u) => fits(u, g)).sort(bySeats);
    if (candidates[0]) {
      free.splice(free.indexOf(candidates[0]), 1);
      out.push({ groupId: g.id, unit: candidates[0], estimateMin: 0 });
      continue;
    }
    const next = expected.find((e) => fits(e.unit, g));
    if (next) {
      expected.splice(expected.indexOf(next), 1);
      const min = Math.max(5, Math.ceil((next.at - now) / 60_000 / 5) * 5);
      out.push({ groupId: g.id, unit: null, estimateMin: min });
    } else {
      out.push({ groupId: g.id, unit: null, estimateMin: null });
    }
  }
  return out;
}
