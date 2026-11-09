import { sql } from './db.js';
import { hashPassword } from './auth.js';
import { audit } from './services/audit.js';
import { seedDemo } from './demo.js';
import { applyDemoTranslations } from './demoTranslations.js';

/**
 * Primer arranque en un servidor nuevo:
 *  - BOOTSTRAP_ADMIN_USER / BOOTSTRAP_ADMIN_PASSWORD crean el gestor general si todavía no hay ninguno.
 *  - SEED_DEMO=true crea además el local de demostración "demo" (su administrador "admin" y las
 *    pantallas "cocina" y "barra" usan la misma contraseña que el gestor). Nunca se crean claves conocidas.
 */
export async function bootstrap(log: (m: string) => void) {
  const user = process.env.BOOTSTRAP_ADMIN_USER?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (!user) return;
  if (password.length < 12) {
    log('BOOTSTRAP_ADMIN_PASSWORD debe tener al menos 12 caracteres: no se crea el gestor general.');
    return;
  }
  const [any] = await sql`select 1 from users where role = 'superadmin'`;
  if (!any) {
    await sql`insert into users (username, name, password_hash, role) values (${user}, 'Gestor Loryand', ${await hashPassword(password)}, 'superadmin')`;
    log(`Gestor general "${user}" creado.`);
  }
  await gestorRecovery(user, password, log);
  if (process.env.SEED_DEMO === 'true') {
    const created = await seedDemo({ createGestor: false, adminPassword: password, screenPassword: password });
    if (created) log('Local de demostración "demo" creado (usuarios admin, cocina y barra con la contraseña del gestor; camareros PIN 1111 y 2222).');
    // La carta de demostración, traducida a todos los idiomas (también en servidores ya creados).
    await applyDemoTranslations();
  }
}

/**
 * Último recurso si el gestor pierde la contraseña y el móvil a la vez: en Render, poner
 * GESTOR_RECOVERY con la fecha de hoy (AAAA-MM-DD) y reiniciar. La contraseña vuelve a ser
 * BOOTSTRAP_ADMIN_PASSWORD y se quita la doble verificación (hay que activarla de nuevo al entrar).
 * Solo actúa una vez por fecha y solo ese día; después hay que borrar la variable.
 */
async function gestorRecovery(user: string, password: string, log: (m: string) => void) {
  const date = process.env.GESTOR_RECOVERY?.trim();
  if (!date) return;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  if (date !== today) { log('GESTOR_RECOVERY no es la fecha de hoy: no se hace nada. Bórrala de las variables de entorno.'); return; }
  const [done] = await sql`select 1 from audit_log where action = 'gestor.recovery' and detail->>'date' = ${date}`;
  if (done) { log('GESTOR_RECOVERY ya se aplicó hoy. Bórrala de las variables de entorno.'); return; }
  await sql.begin(async (tx) => {
    const [u] = await tx`update users set password_hash = ${await hashPassword(password)}, totp_enabled = false, totp_secret_enc = null, totp_last_step = null
                         where lower(username) = lower(${user}) and role = 'superadmin' returning id`;
    if (!u) { log(`GESTOR_RECOVERY: no existe el gestor "${user}".`); return; }
    await tx`delete from recovery_codes where user_id = ${u.id}`;
    await tx`delete from sessions where user_id = ${u.id}`;
    await audit(tx, null, 'sistema', 'gestor.recovery', { date, userId: u.id });
    log(`GESTOR_RECOVERY: restablecida la contraseña del gestor "${user}" y quitada la doble verificación. Borra la variable.`);
  });
}
