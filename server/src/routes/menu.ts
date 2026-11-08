import type { FastifyInstance } from 'fastify';
import { sql } from '../db.js';
import { actorLabel, establishmentOf, requireModule } from '../auth.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { audit } from '../services/audit.js';
import { menuSchema } from '../services/menu.js';

/** Menú del día (capítulo 8): independiente de la carta habitual. */
export default async function menuRoutes(app: FastifyInstance) {
  app.get('/api/admin/menu', async (req) => {
    requireModule(req, 'config');
    const [m] = await sql`select * from daily_menus where establishment_id = ${establishmentOf(req)}`;
    return m ?? null;
  });

  app.put('/api/admin/menu', async (req) => {
    const a = requireModule(req, 'config');
    const est = establishmentOf(req);
    const b = parse(menuSchema, req.body);
    const [m] = await sql`
      insert into daily_menus (establishment_id, name, price_cents, vat_rate, sections, active, updated_at)
      values (${est}, ${b.name}, ${b.priceCents}, ${b.vatRate}, ${sql.json(b.sections)}, ${b.active}, now())
      on conflict (establishment_id) do update set name = excluded.name, price_cents = excluded.price_cents,
        vat_rate = excluded.vat_rate, sections = excluded.sections, active = excluded.active, updated_at = now()
      returning *`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'menu.save', { active: b.active, priceCents: b.priceCents }));
    notify(est, ['products']);
    return m;
  });
}
