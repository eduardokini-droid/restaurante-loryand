import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { actorLabel, hashPassword, requireActor } from '../auth.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { audit } from '../services/audit.js';

const FEATURES = ['tpv', 'pda', 'kitchen', 'bar', 'menu', 'tables', 'cash'] as const;

function requireSuper(req: FastifyRequest) {
  const a = requireActor(req);
  if (a.kind !== 'user' || a.role !== 'superadmin') throw forbidden();
  return a;
}

/** Panel del gestor general de Loryand: alta de establecimientos y funciones contratadas. */
export default async function platformRoutes(app: FastifyInstance) {
  app.get('/api/platform/establishments', async (req) => {
    requireSuper(req);
    return sql`select e.id, e.slug, e.name, e.features, e.active, e.created_at,
                      (select count(*)::int from tables t where t.establishment_id = e.id and t.active) as active_tables
               from establishments e order by e.name`;
  });

  app.post('/api/platform/establishments', async (req) => {
    const a = requireSuper(req);
    const b = parse(z.object({
      name: z.string().min(1).max(120),
      slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, 'solo minúsculas, números y guiones'),
      admin: z.object({ name: z.string().min(1), username: z.string().min(3).max(40), password: z.string().min(8), email: z.string().trim().toLowerCase().email('Correo no válido').max(120).optional() }),
      features: z.array(z.enum(FEATURES)).default([...FEATURES]),
    }), req.body);
    return sql.begin(async (tx) => {
      const [dup] = await tx`select 1 from establishments where slug = ${b.slug}`;
      if (dup) throw conflict('slug_taken', 'Ese identificador ya existe');
      const [u] = await tx`select 1 from users where lower(username) = lower(${b.admin.username})`;
      if (u) throw conflict('username_taken', 'Ese usuario ya existe');
      const [e] = await tx`insert into establishments (name, slug, features) values (${b.name}, ${b.slug}, ${b.features}) returning *`;
      await tx`insert into users (establishment_id, username, name, password_hash, role, email)
               values (${e.id}, ${b.admin.username}, ${b.admin.name}, ${await hashPassword(b.admin.password)}, 'admin', ${b.admin.email ?? null})`;
      await audit(tx, e.id, actorLabel(a), 'establishment.create', { slug: b.slug });
      return e;
    });
  });

  app.patch('/api/platform/establishments/:id', async (req) => {
    const a = requireSuper(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ features: z.array(z.enum(FEATURES)), active: z.boolean(), name: z.string().min(1) }).partial(), req.body);
    const [e] = await sql`update establishments set ${sql(b as Record<string, unknown>)} where id = ${id} returning *`;
    if (!e) throw notFound('Establecimiento');
    await sql.begin((tx) => audit(tx, id, actorLabel(a), 'establishment.platform_update', b));
    return e;
  });
}
