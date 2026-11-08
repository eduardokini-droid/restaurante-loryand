import { Server } from 'socket.io';
import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { actorFromToken, COOKIE } from './auth.js';
import { setIo } from './realtime.js';
import { sql } from './db.js';
import { bootstrap } from './bootstrap.js';

const applied = await migrate();
if (applied.length) console.log('Migraciones aplicadas:', applied.join(', '));
await bootstrap((m) => console.log(m));

const app = await buildApp({ logger: true });
const io = new Server(app.server, { path: '/socket.io', serveClient: false });
setIo(io);

io.on('connection', async (socket) => {
  // Personal autenticado: sala del establecimiento. Carta del cliente: sala de su mesa.
  const cookies = Object.fromEntries((socket.handshake.headers.cookie ?? '').split(';').map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
  const actor = await actorFromToken(cookies[COOKIE]);
  const estHeader = socket.handshake.auth?.establishmentId as string | undefined;
  if (actor) {
    const est = actor.kind === 'user' && actor.role === 'superadmin' ? estHeader : actor.establishmentId;
    if (est) socket.join(`est:${est}`);
  }
  const tableToken = socket.handshake.auth?.tableToken as string | undefined;
  if (tableToken && /^[a-f0-9]{16,64}$/.test(tableToken)) {
    const [t] = await sql`select 1 from tables where qr_token = ${tableToken}`;
    if (t) socket.join(`table:${tableToken}`);
  }
});

await app.listen({ port: config.port, host: '0.0.0.0' });
