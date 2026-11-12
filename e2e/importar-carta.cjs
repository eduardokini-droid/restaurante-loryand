// Importar una carta preparada (archivo + fotos) y verla en la carta del cliente.
// Uso: node e2e/importar-carta.cjs <carpeta-capturas> <archivo-carta.json> <carpeta-fotos>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const [OUT, JSONFILE, PHOTOS] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const p = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 } })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/status of 401/.test(m.text()) && errors.push(m.text()));
  await p.goto('http://localhost:3000/gestion');
  await p.fill('input[autocomplete=username]', 'admin'); await p.fill('input[type=password]', 'admin1234');
  await p.click('button:has-text("Entrar")');
  await p.waitForSelector('text=Mesas con cuenta abierta');
  await p.click('nav a:has-text("Configuración y carta")');
  await p.click('button:has-text("Importar carta")');
  await p.setInputFiles('.modal label:has-text("archivo de la carta") input', JSONFILE);
  const photos = fs.readdirSync(PHOTOS).map((f) => path.join(PHOTOS, f));
  await p.setInputFiles('.modal label:has-text("fotos") input', photos);
  await p.waitForSelector(`.modal >> text=Fotos elegidas: ${photos.length}`);
  await p.screenshot({ path: `${OUT}/imp-1-resumen.png` });
  await p.click('.modal button:has-text("Importar")');
  await p.waitForSelector('.modal >> text=Carta importada.', { timeout: 120000 });
  await p.click('.modal button:has-text("Cerrar")');
  const data = JSON.parse(fs.readFileSync(JSONFILE, 'utf8'));
  const prods = await p.evaluate(() => fetch('/api/admin/products').then((r) => r.json()));
  const imported = data.productos.filter((x) => prods.some((y) => y.name === x.nombre));
  if (imported.length !== data.productos.length) throw new Error(`Importados ${imported.length} de ${data.productos.length}`);
  const withPhoto = prods.filter((y) => data.productos.some((x) => x.nombre === y.name) && y.photo_url).length;
  // Repetir no duplica.
  await p.click('button:has-text("Importar carta")');
  await p.setInputFiles('.modal label:has-text("archivo de la carta") input', JSONFILE);
  await p.click('.modal button:has-text("Importar")');
  await p.waitForSelector('.modal >> text=Carta importada.', { timeout: 120000 });
  const again = await p.evaluate(() => fetch('/api/admin/products').then((r) => r.json()));
  if (again.length !== prods.length) throw new Error('La segunda importación ha duplicado productos');
  await p.click('.modal button:has-text("Cerrar")');
  // Carta del cliente.
  const tables = await p.evaluate(() => fetch('/api/admin/tables').then((r) => r.json()));
  const m = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  await m.goto(`http://localhost:3000/carta/${tables[0].qr_token}`);
  await m.click('.chip:has-text("Conservas")');
  await m.waitForSelector('text=Berberechos al natural (Dani)');
  await m.screenshot({ path: `${OUT}/imp-2-carta.png` });
  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log(`Importación OK: ${imported.length} productos, ${withPhoto} con foto`);
})().catch((e) => { console.error(e); process.exit(1); });
