// Categorías y subcategorías: crear, ordenar, renombrar y usarlas en un producto.
// Uso: node e2e/categorias.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const p = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/status of 401/.test(m.text()) && errors.push(m.text()));
  p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Cócteles de la casa' : undefined));
  await p.goto('http://localhost:3000/gestion');
  await p.fill('input[autocomplete=username]', 'admin'); await p.fill('input[type=password]', 'admin1234');
  await p.click('button:has-text("Entrar")');
  await p.waitForSelector('text=Mesas con cuenta abierta');
  await p.click('nav a:has-text("Configuración y carta")');
  await p.click('button:has-text("Categorías y subcategorías")');
  await p.fill('.modal label:has-text("Nombre") input', 'Cócteles');
  await p.click('.modal button:has-text("Crear categoría")');
  await p.waitForSelector('.modal strong:text-is("Cócteles")');
  await p.fill('.modal label:has-text("Nombre") input', 'Mojitos');
  await p.selectOption('.modal label:has-text("Dónde va") select', { label: 'Subcategoría dentro de «Cócteles»' });
  await p.click('.modal button:has-text("Crear subcategoría")');
  await p.waitForSelector('.modal >> text=↳ Mojitos');
  // Subir «Cócteles» al principio y renombrarla.
  while (await p.locator('.modal button[aria-label="Subir Cócteles"]').isEnabled()) { await p.click('.modal button[aria-label="Subir Cócteles"]'); await p.waitForTimeout(400); }
  await p.click('.modal .spread:has(strong:text-is("Cócteles")) button:has-text("Renombrar")');
  await p.waitForSelector('.modal strong:text-is("Cócteles de la casa")');
  await p.screenshot({ path: `${OUT}/cat-1-ventana.png` });
  const first = await p.locator('.modal strong').first().textContent();
  if (first !== 'Cócteles de la casa') throw new Error(`Orden incorrecto: primera categoría ${first}`);
  await p.click('.modal button[aria-label="Cerrar"], .modal .close, .modal button:has-text("×")').catch(() => p.keyboard.press('Escape'));
  // Un producto nuevo en la subcategoría.
  await p.click('button:has-text("+ Añadir producto")');
  await p.fill('.modal label:has-text("Nombre") input', 'Mojito clásico');
  await p.fill('.modal label:has-text("Precio") input', '7,50');
  await p.selectOption('.modal label:text-is("Categoría") select, .modal label:has-text("Categoría") >> nth=0 >> select', { label: 'Cócteles de la casa' });
  await p.selectOption('.modal label:has-text("Subcategoría") select', { label: 'Mojitos' });
  await p.click('.modal button:has-text("Añadir a la carta")');
  await p.waitForSelector('tr:has-text("Mojito clásico"):has-text("Mojitos")');
  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('Categorías OK');
})().catch((e) => { console.error(e); process.exit(1); });
