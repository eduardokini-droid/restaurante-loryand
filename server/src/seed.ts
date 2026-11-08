/** Datos de demostración. Uso: npm run seed (no borra nada si el local "demo" ya existe). */
import { sql } from './db.js';
import { migrate } from './migrate.js';
import { hashPassword, pinLookup } from './auth.js';

await migrate();
const [exists] = await sql`select id from establishments where slug = 'demo'`;
if (exists) {
  console.log('El local de demostración ya existe.');
  await sql.end();
  process.exit(0);
}

await sql.begin(async (tx) => {
  const [su] = await tx`select 1 from users where username = 'gestor'`;
  if (!su) {
    await tx`insert into users (username, name, password_hash, role) values ('gestor', 'Gestor Loryand', ${await hashPassword('gestor1234')}, 'superadmin')`;
  }
  const [e] = await tx`
    insert into establishments (slug, name, legal_name, tax_id, address, city, province, postal_code, phone)
    values ('demo', 'Casa Demo', 'Casa Demo S.L.', 'B00000000', 'Calle Mayor 1', 'Madrid', 'Madrid', '28001', '910000000')
    returning id`;
  const est = e.id;
  await tx`insert into users (establishment_id, username, name, password_hash, role)
           values (${est}, 'admin', 'Administrador', ${await hashPassword('admin1234')}, 'admin')`;
  await tx`insert into users (establishment_id, username, name, password_hash, role, permissions)
           values (${est}, 'cocina', 'Pantalla de cocina', ${await hashPassword('cocina1234')}, 'staff', ${['kitchen']}),
                  (${est}, 'barra', 'Pantalla de barra', ${await hashPassword('barra1234')}, 'staff', ${['bar']})`;
  for (const [code, name, pin] of [[1, 'Ana', '1111'], [2, 'Luis', '2222']] as const) {
    await tx`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup)
             values (${est}, ${code}, ${name}, ${await hashPassword(pin)}, ${pinLookup(est, pin)})`;
  }
  const cat = async (name: string, sort: number, parent: string | null = null) =>
    (await tx`insert into categories (establishment_id, name, sort, parent_id) values (${est}, ${name}, ${sort}, ${parent}) returning id`)[0].id as string;
  const comida = await cat('Comida', 1);
  const entrantes = await cat('Entrantes', 1, comida);
  const principales = await cat('Principales', 2, comida);
  const postres = await cat('Postres', 3, comida);
  const bebidas = await cat('Bebidas', 2);
  const refrescos = await cat('Refrescos', 1, bebidas);
  const vinos = await cat('Vinos y cervezas', 2, bebidas);
  const cafes = await cat('Cafés', 3, bebidas);

  type P = [string, string, number, string, string, number, string[], string[]];
  const products: P[] = [
    ['Croquetas caseras', 'Jamón ibérico, 8 unidades', 950, comida, entrantes, 1, [], ['gluten', 'lacteos', 'huevos']],
    ['Ensalada de temporada', 'Tomate, ventresca y cebolla morada', 1100, comida, entrantes, 1, [], ['pescado']],
    ['Patatas bravas', 'Salsa brava de la casa y alioli', 650, comida, entrantes, 1, [], ['huevos']],
    ['Entrecot a la brasa', '300 g con patatas y pimientos', 2250, comida, principales, 2, ['Poco hecho', 'Al punto', 'Hecho'], []],
    ['Merluza a la gallega', 'Con cachelos y ajada', 1850, comida, principales, 2, [], ['pescado']],
    ['Arroz negro', 'Mínimo 2 personas, precio por ración', 1600, comida, principales, 2, [], ['moluscos', 'crustaceos']],
    ['Tarta de queso', 'Al horno, cremosa', 600, comida, postres, 3, [], ['lacteos', 'huevos', 'gluten']],
    ['Flan casero', '', 500, comida, postres, 3, [], ['lacteos', 'huevos']],
    ['Refresco', '33 cl', 280, bebidas, refrescos, 1, ['Coca-Cola', 'Coca-Cola Zero', 'Naranja', 'Limón'], []],
    ['Agua mineral', '50 cl', 200, bebidas, refrescos, 1, ['Natural', 'Fría', 'Con gas'], []],
    ['Caña', '', 250, bebidas, vinos, 1, [], ['gluten']],
    ['Copa de vino', '', 350, bebidas, vinos, 1, ['Rioja', 'Ribera', 'Albariño', 'Verdejo'], ['sulfitos']],
    ['Café', '', 150, bebidas, cafes, 3, ['Solo', 'Cortado', 'Con leche', 'Descafeinado'], ['lacteos']],
  ];
  for (const [name, description, price, c, s, course, options, allergens] of products) {
    const destination = c === bebidas ? 'bar' : 'kitchen';
    await tx`insert into products (establishment_id, name, description, price_cents, category_id, subcategory_id, course, destination, options, allergens, vat_rate)
             values (${est}, ${name}, ${description}, ${price}, ${c}, ${s}, ${course}, ${destination}, ${options}, ${allergens}, 10)`;
  }
  await tx`insert into daily_menus (establishment_id, name, price_cents, sections, active) values (${est}, 'Menú del día', 1450,
    ${tx.json({ first: ['Lentejas estofadas', 'Ensalada mixta', 'Gazpacho'], second: ['Merluza a la plancha', 'Pollo asado', 'Albóndigas'], dessert: ['Flan', 'Fruta del tiempo'], drink: ['Agua', 'Vino de la casa', 'Refresco'], coffee: [] })}, true)`;
  const tables: [string, string, number][] = [
    ['1', 'salon', 2], ['2', 'salon', 4], ['3', 'salon', 4], ['4', 'salon', 6],
    ['T1', 'terraza', 4], ['T2', 'terraza', 4], ['T3', 'terraza', 2], ['R1', 'reservado', 10],
  ];
  for (const [label, zone, seats] of tables) {
    // Las mesas 2 y 3 se juntan habitualmente (unión "A").
    await tx`insert into tables (establishment_id, label, zone, seats, join_group) values (${est}, ${label}, ${zone}, ${seats}, ${['2', '3'].includes(label) ? 'A' : null})`;
  }
});

console.log(`Datos de demostración creados.
  Gestor general:  gestor / gestor1234
  Administrador:   admin / admin1234
  Cocina / Barra:  cocina / cocina1234 · barra / barra1234
  Camareros (PDA): local "demo" · camarero-1 PIN 1111 · camarero-2 PIN 2222`);
await sql.end();
