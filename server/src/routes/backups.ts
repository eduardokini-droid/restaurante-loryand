import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { actorLabel, establishmentOf, requireActor } from '../auth.js';
import { forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { audit } from '../services/audit.js';
import { checkRestore, restore, saveBackup, summarize, validateFormat } from '../services/backups.js';

/** Solo el administrador del local o el gestor general. */
function requireAdmin(req: FastifyRequest) {
  const a = requireActor(req);
  if (a.kind !== 'user' || a.role === 'staff') throw forbidden('Solo el administrador puede gestionar las copias');
  return a;
}

/** Copias de seguridad (capítulo 25). */
export default async function backupRoutes(app: FastifyInstance) {
  app.get('/api/backups', async (req) => {
    requireAdmin(req);
    return sql`select id, kind, size_bytes, summary, created_at from backups where establishment_id = ${establishmentOf(req)} order by created_at desc`;
  });

  app.post('/api/backups', async (req) => {
    const a = requireAdmin(req);
    const est = establishmentOf(req);
    const b = await saveBackup(sql, est, 'manual');
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'backup.create', { id: b.id }));
    return b;
  });

  app.get('/api/backups/:id/download', async (req, reply) => {
    requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [b] = await sql`select data, created_at from backups where id = ${id} and establishment_id = ${establishmentOf(req)}`;
    if (!b) throw notFound('Copia');
    const stamp = new Date(b.created_at).toISOString().slice(0, 16).replace(/[T:]/g, '-');
    reply.header('content-disposition', `attachment; filename="loryand-copia-${stamp}.json"`);
    reply.type('application/json');
    return JSON.stringify(b.data);
  });

  const source = z.union([z.object({ backupId: z.string().uuid() }), z.object({ data: z.unknown() })]);
  async function load(req: FastifyRequest, body: z.infer<typeof source>) {
    if ('backupId' in body) {
      const [b] = await sql`select data from backups where id = ${body.backupId} and establishment_id = ${establishmentOf(req)}`;
      if (!b) throw notFound('Copia');
      return validateFormat(b.data);
    }
    return validateFormat(body.data);
  }

  /** "Verificar y mostrar resumen": nada se modifica. */
  app.post('/api/backups/verify', { bodyLimit: 50_000_000 }, async (req) => {
    requireAdmin(req);
    const est = establishmentOf(req);
    const data = await load(req, parse(source, req.body));
    return { summary: summarize(data), problems: await checkRestore(sql, est, data) };
  });

  /** "Crear copia preventiva y restaurar". */
  app.post('/api/backups/restore', { bodyLimit: 50_000_000 }, async (req) => {
    const a = requireAdmin(req);
    const est = establishmentOf(req);
    const body = parse(source, req.body);
    const data = await load(req, body);
    const preventive = await sql.begin(async (tx) => {
      await tx`select id from establishments where id = ${est} for update`;
      const p = await restore(tx, est, data);
      await audit(tx, est, actorLabel(a), 'backup.restore', { from: data.createdAt, preventive: p.id });
      return p;
    });
    return { ok: true, preventiveBackupId: preventive.id };
  });
}
