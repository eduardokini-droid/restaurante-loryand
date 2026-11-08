import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sql } from '../db.js';
import { actorLabel, establishmentOf, requireActor, requireService } from '../auth.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { audit } from '../services/audit.js';
import { testTicket } from '../services/escpos.js';
import { DEFAULT_AUTOPRINT, enqueue, printDocument, printOrder } from '../services/printing.js';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const ROLES = z.array(z.enum(['kitchen', 'bar', 'ticket'])).max(3);

function requireAdmin(req: FastifyRequest) {
  const a = requireActor(req);
  if (a.kind !== 'user' || a.role === 'staff') throw forbidden('Solo el administrador puede configurar las impresoras');
  return a;
}

/** Autenticación del agente de impresión por token (cabecera Authorization: Bearer …). */
async function requireAgent(req: FastifyRequest) {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) throw new AppError(401, 'unauthenticated', 'Falta el token del agente');
  const [a] = await sql`select pa.id, pa.establishment_id from print_agents pa join establishments e on e.id = pa.establishment_id
                        where pa.token_hash = ${sha(token)} and e.active`;
  if (!a) throw new AppError(401, 'bad_token', 'Token de agente no válido');
  return a as { id: string; establishment_id: string };
}

const printerSchema = z.object({
  name: z.string().min(1).max(60),
  connection: z.enum(['tcp', 'device', 'windows', 'cups']),
  address: z.string().min(1).max(200),
  widthChars: z.number().int().min(24).max(64),
  roles: ROLES,
  active: z.boolean(),
});

function validateAddress(connection: string, address: string) {
  if (connection === 'tcp' && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(address)) throw conflict('bad_address', 'Indica la IP de la impresora, por ejemplo 192.168.1.50 (puerto 9100 por defecto)');
  if (connection === 'device' && !address.startsWith('/dev/')) throw conflict('bad_address', 'Indica el dispositivo, por ejemplo /dev/usb/lp0');
  if (connection === 'windows' && /[\\/]/.test(address) === false && !/^[\w .-]+$/.test(address)) throw conflict('bad_address', 'Indica el nombre con el que está compartida la impresora en Windows');
}

const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../agent');
const AGENT_FILES: Record<string, string> = { 'agente.mjs': 'text/javascript', 'iniciar-agente.bat': 'application/octet-stream', 'iniciar-agente.sh': 'text/x-shellscript', 'LEEME.md': 'text/markdown' };

export default async function printingRoutes(app: FastifyInstance) {
  /** Descarga de los archivos del agente de impresión. */
  app.get('/api/printing/agent-files/:file', async (req, reply) => {
    requireAdmin(req);
    const { file } = parse(z.object({ file: z.enum(Object.keys(AGENT_FILES) as [string, ...string[]]) }), req.params);
    const data = await readFile(path.join(AGENT_DIR, file)).catch(() => { throw notFound('Archivo'); });
    reply.header('content-disposition', `attachment; filename="${file}"`).type(AGENT_FILES[file]);
    return data;
  });

  // ---------- Configuración ----------
  app.get('/api/printing', async (req) => {
    requireAdmin(req);
    const est = establishmentOf(req);
    const [e] = await sql`select settings from establishments where id = ${est}`;
    return {
      agents: await sql`select id, name, last_seen_at, version, created_at, (last_seen_at > now() - interval '30 seconds') as online
                        from print_agents where establishment_id = ${est} order by created_at`,
      printers: await sql`select * from printers where establishment_id = ${est} order by created_at`,
      autoPrint: { ...DEFAULT_AUTOPRINT, ...(e.settings?.autoPrint ?? {}) },
    };
  });

  app.put('/api/printing/settings', async (req) => {
    requireAdmin(req);
    const est = establishmentOf(req);
    const b = parse(z.object({ kitchen: z.boolean(), bar: z.boolean(), ticket: z.boolean(), drawer: z.boolean().default(true) }), req.body);
    await sql`update establishments set settings = jsonb_set(settings, '{autoPrint}', ${sql.json(b)}) where id = ${est}`;
    return b;
  });

  /** Alta de un agente: el token se muestra una sola vez. */
  app.post('/api/printing/agents', async (req) => {
    const a = requireAdmin(req);
    const est = establishmentOf(req);
    const { name } = parse(z.object({ name: z.string().min(1).max(60) }), req.body);
    const token = `lpa_${randomBytes(24).toString('base64url')}`;
    const [ag] = await sql`insert into print_agents (establishment_id, name, token_hash) values (${est}, ${name}, ${sha(token)}) returning id, name`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'printing.agent_create', { id: ag.id }));
    return { ...ag, token };
  });

  app.delete('/api/printing/agents/:id', async (req) => {
    const a = requireAdmin(req);
    const est = establishmentOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await sql`delete from print_agents where id = ${id} and establishment_id = ${est}`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'printing.agent_delete', { id }));
    return { ok: true };
  });

  app.post('/api/printing/printers', async (req) => {
    requireAdmin(req);
    const est = establishmentOf(req);
    const b = parse(printerSchema.partial({ active: true, widthChars: true }), req.body);
    validateAddress(b.connection, b.address);
    const [p] = await sql`insert into printers (establishment_id, name, connection, address, width_chars, roles, active)
                          values (${est}, ${b.name}, ${b.connection}, ${b.address.trim()}, ${b.widthChars ?? 48}, ${b.roles}, ${b.active ?? true}) returning *`;
    return p;
  });

  app.patch('/api/printing/printers/:id', async (req) => {
    requireAdmin(req);
    const est = establishmentOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(printerSchema.partial(), req.body);
    const [cur] = await sql`select connection, address from printers where id = ${id} and establishment_id = ${est}`;
    if (!cur) throw notFound('Impresora');
    validateAddress(b.connection ?? cur.connection, b.address ?? cur.address);
    const cols: Record<string, unknown> = {};
    for (const [k, c] of Object.entries({ name: 'name', connection: 'connection', address: 'address', widthChars: 'width_chars', roles: 'roles', active: 'active' })) {
      if (b[k as keyof typeof b] !== undefined) cols[c] = b[k as keyof typeof b];
    }
    const [p] = await sql`update printers set ${sql(cols)} where id = ${id} returning *`;
    return p;
  });

  app.delete('/api/printing/printers/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await sql`delete from printers where id = ${id} and establishment_id = ${establishmentOf(req)}`;
    return { ok: true };
  });

  app.post('/api/printing/printers/:id/test', async (req) => {
    requireAdmin(req);
    const est = establishmentOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [p] = await sql`select p.name, p.width_chars, e.name as est from printers p join establishments e on e.id = p.establishment_id where p.id = ${id} and p.establishment_id = ${est}`;
    if (!p) throw notFound('Impresora');
    const jobId = await enqueue(sql, est, id, 'test', `Prueba · ${p.name}`, testTicket(p.name, p.est, p.width_chars));
    return { jobId };
  });

  // ---------- Trabajos (personal) ----------
  app.get('/api/printing/jobs', async (req) => {
    requireService(req);
    return sql`select j.id, j.kind, j.title, j.status, j.attempts, j.error, j.created_at, j.printed_at, p.name as printer
               from print_jobs j join printers p on p.id = j.printer_id
               where j.establishment_id = ${establishmentOf(req)} order by j.created_at desc limit 50`;
  });

  app.post('/api/printing/jobs/:id/retry', async (req) => {
    requireService(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [j] = await sql`update print_jobs set status = 'queued', attempts = 0, error = null where id = ${id} and establishment_id = ${establishmentOf(req)} returning id`;
    if (!j) throw notFound('Trabajo');
    return { ok: true };
  });

  app.post('/api/service/documents/:id/print', async (req) => {
    requireService(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const n = await printDocument(establishmentOf(req), id);
    if (!n) throw conflict('no_printer', 'No hay ninguna impresora de tickets configurada');
    return { jobs: n };
  });

  app.post('/api/service/orders/:id/reprint', async (req) => {
    requireActor(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const n = await printOrder(establishmentOf(req), id, { force: true });
    if (!n) throw conflict('no_printer', 'No hay impresoras de cocina o barra configuradas para este pedido');
    return { jobs: n };
  });

  app.get('/api/printing/status', async (req) => {
    requireActor(req);
    const est = establishmentOf(req);
    const [s] = await sql`select
      (select count(*)::int from print_agents where establishment_id = ${est} and last_seen_at > now() - interval '30 seconds') as agents_online,
      (select count(*)::int from printers where establishment_id = ${est} and active) as printers,
      (select count(*)::int from print_jobs where establishment_id = ${est} and status in ('queued','sent')) as pending,
      (select count(*)::int from print_jobs where establishment_id = ${est} and status = 'failed' and created_at > now() - interval '12 hours') as failed`;
    return s;
  });

  // ---------- API del agente de impresión ----------
  /** El agente recoge los trabajos pendientes. Un trabajo enviado sin respuesta en 60 s vuelve a la cola (máx. 5 intentos). */
  app.post('/api/agent/poll', async (req) => {
    const ag = await requireAgent(req);
    const { version } = parse(z.object({ version: z.string().max(20).default('') }), req.body ?? {});
    await sql`update print_agents set last_seen_at = now(), version = coalesce(nullif(${version}, ''), version) where id = ${ag.id}`;
    await sql`update print_jobs set status = 'failed', error = coalesce(error, 'Sin respuesta del agente tras 5 intentos')
              where establishment_id = ${ag.establishment_id} and status = 'sent' and sent_at < now() - interval '60 seconds' and attempts >= 5`;
    const jobs = await sql`
      update print_jobs j set status = 'sent', sent_at = now(), attempts = attempts + 1, agent_id = ${ag.id}
      from printers p
      where j.id in (select id from print_jobs where establishment_id = ${ag.establishment_id}
                       and (status = 'queued' or (status = 'sent' and sent_at < now() - interval '60 seconds' and attempts < 5))
                     order by created_at limit 10 for update skip locked)
        and p.id = j.printer_id
      returning j.id, j.title, j.payload, p.connection, p.address, p.name as printer`;
    return { jobs: jobs.map((j) => ({ id: j.id, title: j.title, printer: { name: j.printer, connection: j.connection, address: j.address }, data: Buffer.from(j.payload).toString('base64') })) };
  });

  app.post('/api/agent/jobs/:id/result', async (req) => {
    const ag = await requireAgent(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ ok: z.boolean(), error: z.string().max(500).optional() }), req.body);
    await sql`update print_jobs set status = ${b.ok ? 'printed' : 'failed'}, printed_at = ${b.ok ? new Date() : null}, error = ${b.ok ? null : b.error ?? 'Error de impresión'}
              where id = ${id} and establishment_id = ${ag.establishment_id}`;
    return { ok: true };
  });
}
