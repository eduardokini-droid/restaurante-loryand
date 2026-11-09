// Informes de ventas: tras los servicios de las otras pruebas, comprueba cifras, gráfica por hora y exportación a Excel.
// Uso: node e2e/informes.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !m.location().url.endsWith('/api/auth/me') && errors.push(m.text() + ' ' + JSON.stringify(m.location())));
  await p.goto('http://localhost:3000/gestion');
  await p.fill('input[autocomplete=username]', 'admin');
  await p.fill('input[type=password]', 'admin1234');
  await p.click('button:has-text("Entrar")');
  await p.waitForSelector('text=Mesas con cuenta abierta');
  await p.click('nav a:has-text("Informes")');
  await p.waitForSelector('text=Total cobrado');
  const tickets = Number(await p.locator('.card:has-text("Tickets") >> div >> nth=1').first().textContent());
  if (!(tickets > 0)) throw new Error(`Sin tickets en el informe: ${tickets}`);
  if (!(await p.locator('[aria-label="Ventas por hora"] > div').count())) throw new Error('Sin barras por hora');
  await p.fill('input[placeholder="Filtrar producto o categoría"]', 'croq');
  await p.waitForSelector('td:has-text("Croquetas")');
  await p.fill('input[placeholder="Filtrar producto o categoría"]', '');
  await p.screenshot({ path: `${OUT}/informes.png`, fullPage: true });
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Exportar a Excel")')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  for (const s of ['RESUMEN', 'POR PRODUCTO', 'POR CAMARERO', 'POR HORA']) if (!csv.includes(s)) throw new Error(`Falta la sección ${s} en el CSV`);
  if (!dl.suggestedFilename().startsWith('ventas-')) throw new Error(dl.suggestedFilename());
  await p.click('button:has-text("Mes anterior")');
  await p.waitForTimeout(600);
  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log(`Informes OK: ${tickets} tickets, CSV ${csv.length} bytes`);
})().catch((e) => { console.error(e); process.exit(1); });
