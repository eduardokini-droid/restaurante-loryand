// Protección de datos: datos del titular → textos legales, casillas en la reserva web, alta en fidelización
// con información al cliente, exportación y baja desde la tarjeta. Uso: node e2e/rgpd.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = async (opts = {}) => {
    const p = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1180, height: 860 }, acceptDownloads: true, ...opts })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && !/status of 40[134]/.test(m.text()) && errors.push(m.text()));
    return p;
  };
  // 1. Datos del titular y plazos.
  const a = await page();
  await a.goto('http://localhost:3000/gestion');
  await a.fill('input[autocomplete=username]', 'admin');
  await a.fill('input[type=password]', 'admin1234');
  await a.click('button:has-text("Entrar")');
  await a.waitForSelector('text=Mesas con cuenta abierta');
  await a.click('nav a:has-text("Datos del negocio")');
  await a.waitForSelector('text=Protección de datos');
  const field = (label) => a.locator(`label:has-text("${label}") input`).first();
  await field('Razón social').fill('Hostelería El Laurel S.L.');
  await field('DNI / CIF').fill('B12345678');
  await field('Dirección').fill('C/ Mayor 12');
  await field('Localidad').fill('Toledo');
  await field('Correo para ejercer').fill('privacidad@ellaurel.es');
  await field('Anonimizar reservas').fill('6');
  await a.click('button:has-text("Guardar datos del establecimiento")');
  await a.waitForSelector('text=Datos del establecimiento guardados');
  await a.waitForSelector('text=Faltan datos', { state: 'detached' });
  await a.screenshot({ path: `${OUT}/rgpd-1-negocio.png`, fullPage: true });

  // 2. Textos públicos y cartel.
  const pub = await page({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await pub.goto('http://localhost:3000/legal/demo');
  await pub.waitForSelector('text=Hostelería El Laurel S.L. (NIF B12345678)');
  await pub.waitForSelector('text=privacidad@ellaurel.es');
  await pub.screenshot({ path: `${OUT}/rgpd-2-privacidad.png` });
  await pub.click('button:has-text("Aviso legal")');
  await pub.waitForSelector('text=Ley 34/2002');
  await pub.goto('http://localhost:3000/legal/demo?cartel=1');
  await pub.waitForSelector('img[alt^="Código QR"]');

  // 3. Reserva web: sin la casilla no se puede enviar.
  await pub.goto('http://localhost:3000/reservar/demo');
  await pub.waitForSelector('text=Solicitar reserva');
  await pub.selectOption('select >> nth=0', { index: 1 });
  await pub.fill('input[autocomplete=name]', 'Elena Sanz');
  await pub.fill('input[autocomplete=tel]', '600999888');
  if (!(await pub.locator('button:has-text("Solicitar reserva")').isDisabled())) throw new Error('Se puede reservar sin aceptar la privacidad');
  await pub.check('label:has-text("política de privacidad") input');
  await pub.screenshot({ path: `${OUT}/rgpd-3-reservar.png`, fullPage: true });
  await pub.click('button:has-text("Solicitar reserva")');
  await pub.waitForSelector('text=Todavía no está confirmada');

  // 4. Alta en fidelización: hay que confirmar que se ha informado al cliente.
  await a.click('nav a:has-text("Fidelización")');
  await a.click('button:has-text("+ Nuevo cliente")');
  await a.fill('.modal label:has-text("Nombre") input', 'Rosa Prieto');
  await a.fill('.modal label:has-text("Teléfono") input', '611 777 666');
  await a.click('.modal summary:has-text("Información que hay que dar")');
  await a.waitForSelector('.modal details p:has-text("Hostelería El Laurel S.L.")');
  if (!(await a.locator('.modal button:has-text("Guardar ficha")').isDisabled())) throw new Error('Alta sin informar al cliente');
  await a.check('.modal label:has-text("acepta entrar en el programa") input');
  await a.screenshot({ path: `${OUT}/rgpd-4-alta.png` });
  await a.click('.modal button:has-text("Guardar ficha")');
  await a.waitForSelector('tr:has-text("Rosa Prieto")');
  const [dl] = await Promise.all([a.waitForEvent('download'), a.click('tr:has-text("Rosa Prieto") button:has-text("Exportar datos")')]);
  const data = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
  if (data.cliente.name !== 'Rosa Prieto' || data.consentimientos[0].purpose !== 'privacy') throw new Error('Exportación incorrecta');

  // 5. Tarjeta digital: baja del programa por el propio cliente.
  const token = await a.evaluate(() => fetch('/api/loyalty/customers?q=Rosa').then((r) => r.json()).then((l) => l[0].card_token));
  await pub.goto(`http://localhost:3000/tarjeta/${token}`);
  await pub.waitForSelector('text=Tus datos');
  await pub.screenshot({ path: `${OUT}/rgpd-5-tarjeta.png`, fullPage: true });
  pub.once('dialog', (d) => d.accept());
  await pub.click('button:has-text("Darme de baja")');
  await pub.waitForSelector('text=Te has dado de baja');
  await a.reload();
  await a.waitForSelector('text=Fidelización');
  await a.waitForTimeout(500);
  if (await a.locator('tr:has-text("Rosa Prieto")').count()) throw new Error('La ficha sigue tras la baja');

  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('RGPD OK');
})().catch((e) => { console.error(e); process.exit(1); });
