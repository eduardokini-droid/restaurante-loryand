export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://loryand:loryand@localhost:5432/loryand',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-cambiar',
  port: Number(process.env.PORT ?? 3000),
  // En Render, RENDER_EXTERNAL_URL se define automáticamente con la dirección pública del servicio.
  publicUrl: (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  production: process.env.NODE_ENV === 'production',
};
if (config.production && config.sessionSecret === 'dev-secret-cambiar') {
  throw new Error('SESSION_SECRET debe configurarse en producción');
}
