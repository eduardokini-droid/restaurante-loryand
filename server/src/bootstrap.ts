import { sql } from './db.js';
import { hashPassword } from './auth.js';
import { seedDemo } from './demo.js';

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
  if (process.env.SEED_DEMO === 'true') {
    const created = await seedDemo({ createGestor: false, adminPassword: password, screenPassword: password });
    if (created) log('Local de demostración "demo" creado (usuarios admin, cocina y barra con la contraseña del gestor; camareros PIN 1111 y 2222).');
  }
}
