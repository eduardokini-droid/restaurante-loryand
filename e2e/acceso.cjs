// Prueba en navegador del acceso de camareros desde el TPV: QR de un solo uso + PIN en el teléfono.
// Uso: node e2e/acceso.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const tpv = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage();
    tpv.on('pageerror', (e) => errors.push(e.message));
    await tpv.goto('http://localhost:3000/gestion/tpv');
    await tpv.fill('input[autocomplete=username]', 'admin'); await tpv.fill('input[type=password]', 'admin1234');
    await tpv.click('button:has-text("Entrar")');
    await tpv.click('button:has-text("Acceso camareros")');
    const resP = tpv.waitForResponse((r) => r.url().endsWith('/api/service/waiter-access'));
    await tpv.click('.modal .product-btn:has-text("Ana")');
    const access = await (await resP).json();
    await tpv.waitForSelector('img[alt="Código de acceso de Ana"]');
    await tpv.screenshot({ path: `${OUT}/acc-1-tpv-qr.png` });

    // Luis lee el código de Ana con su propio PIN: no entra
    const luis = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
    await luis.goto(`http://localhost:3000${access.path}`);
    await luis.waitForSelector('h1:has-text("Hola, Ana")');
    await luis.fill('input[type=password]', '2222');
    await luis.click('button:has-text("Entrar")');
    await luis.waitForSelector('text=Usuario o PIN incorrectos');

    // Ana, con su PIN, entra y ficha a la vez
    const ana = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
    await ana.goto(`http://localhost:3000${access.path}`);
    await ana.waitForSelector('h1:has-text("Hola, Ana")');
    await ana.screenshot({ path: `${OUT}/acc-2-pin.png` });
    await ana.fill('input[type=password]', '1111');
    await ana.click('button:has-text("Entrar")');
    await ana.waitForSelector('h2:has-text("¿Dónde vas a atender?")');
    const header = await ana.locator('header').textContent();
    await tpv.waitForSelector('text=Ana ha entrado en su teléfono', { timeout: 8000 });
    await tpv.screenshot({ path: `${OUT}/acc-3-tpv-ok.png` });

    // Reutilizar el código: rechazado
    const again = await (await browser.newContext({ locale: 'es-ES' })).newPage();
    await again.goto(`http://localhost:3000${access.path}`);
    await again.waitForSelector('h1:has-text("Código no válido")');
    console.log(JSON.stringify({ anaDentroYFichada: /Ana/.test(header) && /turno desde/.test(header), luisRechazado: true, codigoDeUnSoloUso: true, errors }, null, 1));
  } finally { await browser.close(); }
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
