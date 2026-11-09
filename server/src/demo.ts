/** Crea el local de demostración "demo" si no existe. Devuelve false si ya existía. */
import { sql } from './db.js';
import { hashPassword, pinLookup } from './auth.js';

export async function seedDemo(opts: { createGestor: boolean; adminPassword: string; screenPassword?: string }): Promise<boolean> {
  const [exists] = await sql`select id from establishments where slug = 'demo'`;
  if (exists) return false;
  await sql.begin(async (tx) => {
    if (opts.createGestor) {
      const [su] = await tx`select 1 from users where username = 'gestor'`;
      if (!su) await tx`insert into users (username, name, password_hash, role) values ('gestor', 'Gestor Loryand', ${await hashPassword('gestor1234')}, 'superadmin')`;
    }
    const [e] = await tx`
      insert into establishments (slug, name, legal_name, tax_id, address, city, province, postal_code, phone)
      values ('demo', 'Casa Demo', 'Casa Demo S.L.', 'B00000000', 'Calle Mayor 1', 'Madrid', 'Madrid', '28001', '910000000')
      returning id`;
    const est = e.id;
    await tx`insert into users (establishment_id, username, name, password_hash, role)
             values (${est}, 'admin', 'Administrador', ${await hashPassword(opts.adminPassword)}, 'admin')`;
    await tx`insert into users (establishment_id, username, name, password_hash, role, permissions)
             values (${est}, 'cocina', 'Pantalla de cocina', ${await hashPassword(opts.screenPassword ?? 'cocina1234')}, 'staff', ${['kitchen']}),
                    (${est}, 'barra', 'Pantalla de barra', ${await hashPassword(opts.screenPassword ?? 'barra1234')}, 'staff', ${['bar']})`;
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
    // Almacén, escandallos, fidelización e idiomas de ejemplo.
    const pid = async (name: string) => (await tx`select id from products where establishment_id = ${est} and name = ${name}`)[0].id as string;
    const item = async (name: string, unit: string, stock: number, min: number, cost: number, packQty: number | null = null, packUnit: string | null = null, productId: string | null = null) =>
      (await tx`insert into stock_items (establishment_id, name, unit, stock, min_stock, cost_per_unit, pack_qty, pack_unit, product_id)
                values (${est}, ${name}, ${unit}, ${stock}, ${min}, ${cost}, ${packQty}, ${packUnit}, ${productId}) returning id`)[0].id as string;
    const rioja = await item('Vino Rioja (botella)', 'ud', 12, 6, 600, 0.75, 'l');
    const patatas = await item('Patatas', 'kg', 25, 10, 120);
    const aceite = await item('Aceite de oliva', 'l', 10, 3, 900);
    await item('Refresco 33 cl', 'ud', 48, 24, 45, null, null, await pid('Refresco'));
    await tx`insert into recipe_lines (product_id, item_id, qty, unit) values (${await pid('Copa de vino')}, ${rioja}, 150, 'ml')`;
    await tx`insert into recipe_lines (product_id, item_id, qty, unit) values (${await pid('Patatas bravas')}, ${patatas}, 250, 'g'), (${await pid('Patatas bravas')}, ${aceite}, 30, 'ml')`;
    const [lucia] = await tx`insert into customers (establishment_id, name, phone, points, marketing_consent) values (${est}, 'Lucía Martínez', '600000001', 120, true) returning id`;
    await tx`insert into coupons (establishment_id, customer_id, code, description, kind, value, max_uses, valid_from) values (${est}, ${lucia.id}, 'BIENVENIDA', 'Un 10 % de descuento en tu próxima visita', 'percent', 10, 1, current_date)`;
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
  return true;
}
