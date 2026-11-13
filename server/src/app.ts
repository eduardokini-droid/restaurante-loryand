import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { loadActor } from './auth.js';
import { AppError } from './errors.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import serviceRoutes from './routes/service.js';
import publicRoutes from './routes/public.js';
import reportRoutes from './routes/reports.js';
import platformRoutes from './routes/platform.js';
import menuRoutes from './routes/menu.js';
import reservationRoutes from './routes/reservations.js';
import waitlistRoutes from './routes/waitlist.js';
import stockRoutes from './routes/stock.js';
import loyaltyRoutes from './routes/loyalty.js';
import backupRoutes from './routes/backups.js';
import integrationRoutes from './routes/integrations.js';
import printingRoutes from './routes/printing.js';
import cashRoutes from './routes/cash.js';
import timesheetRoutes from './routes/timesheet.js';
import salesRoutes from './routes/sales.js';
import securityRoutes from './routes/security.js';
import billingRoutes from './routes/billing.js';
import imageRoutes from './routes/images.js';
import invoiceRequestRoutes from './routes/invoiceRequest.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1_000_000 });
  await app.register(cookie);
  app.addHook('preHandler', loadActor);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'bad_request', message: err.issues[0]?.message });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message });
    // Violación de unicidad en base de datos: dos operaciones simultáneas sobre lo mismo.
    if (e.code === '23505') return reply.status(409).send({ error: 'conflict', message: 'La operación entra en conflicto con otra simultánea. Actualiza y vuelve a intentarlo.' });
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Error interno. Anota la hora y la acción realizada.' });
  });

  // Render pone en RENDER_GIT_COMMIT la versión publicada: así se ve en el panel qué versión está funcionando.
  app.get('/api/health', async () => ({ ok: true, version: (process.env.RENDER_GIT_COMMIT ?? 'local').slice(0, 7) }));
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(serviceRoutes);
  await app.register(publicRoutes);
  await app.register(reportRoutes);
  await app.register(platformRoutes);
  await app.register(menuRoutes);
  await app.register(reservationRoutes);
  await app.register(waitlistRoutes);
  await app.register(stockRoutes);
  await app.register(loyaltyRoutes);
  await app.register(backupRoutes);
  await app.register(integrationRoutes);
  await app.register(printingRoutes);
  await app.register(cashRoutes);
  await app.register(timesheetRoutes);
  await app.register(salesRoutes);
  await app.register(securityRoutes);
  await app.register(billingRoutes);
  await app.register(imageRoutes);
  await app.register(invoiceRequestRoutes);

  // En producción el servidor sirve también la aplicación web compilada.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'Ruta no encontrada' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
