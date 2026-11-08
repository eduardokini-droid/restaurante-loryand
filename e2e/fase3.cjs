// Prueba en navegador de la fase 3: plano, almacén/escandallos, cupón en la cuenta, carta en inglés,
// copias de seguridad y tarjeta digital. Ejecutar tras servicio-completo.cjs y fase2.cjs.
// Uso: node e2e/fase3.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, n) => p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
  const admin = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage(); watch(admin, 'admin');
  await admin.goto('http://localhost:3000/gestion');
  await admin.fill('input[autocomplete=username]', 'admin'); await admin.fill('input[type=password]', 'admin1234');
  await admin.click('button:has-text("Entrar")');
  await admin.waitForSelector('text=Mesas con cuenta abierta');
  const get = (url) => admin.evaluate((u) => fetch(u).then((r) => r.json()), url);

  // 1. Plano: colocar una mesa arrastrando
  await admin.click('a:has-text("Plano del local")');
  await admin.click('button:has-text("Colocar mesas")');
  await admin.click('.chip:has-text("Salón")');
  const t1 = admin.locator('div[title^="1 ·"]');
  const box = await t1.boundingBox();
  await admin.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await admin.mouse.down();
  await admin.mouse.move(box.x + 420, box.y + 260, { steps: 12 });
  await admin.mouse.up();
  await admin.waitForTimeout(800);
  await admin.click('button:has-text("Terminar de colocar")');
  await admin.waitForTimeout(500);
  await admin.screenshot({ path: `${OUT}/f3-1-plano.png` });
  const floor = await get('/api/service/floor');
  const mesa1 = floor.tables.find((t) => t.label === '1');

  // 2. Venta de copas de vino → descuenta del almacén según escandallo (150 ml de botella 0,75 l)
  const before = (await get('/api/stock/items')).find((i) => i.name.startsWith('Vino Rioja')).stock;
  const pda = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage(); watch(pda, 'pda');
  pda.on('dialog', (d) => d.accept());
  await pda.goto('http://localhost:3000/personal');
  await pda.fill('input >> nth=0', 'demo'); await pda.fill('input >> nth=1', 'camarero-1'); await pda.fill('input[type=password]', '1111');
  await pda.click('button:has-text("Entrar")');
  await pda.waitForSelector('button:has-text("Fichar entrada"), h2:has-text("¿Dónde vas a atender?")');
  if (await pda.locator('button:has-text("Fichar entrada")').count()) await pda.click('button:has-text("Fichar entrada")');
  await pda.click('.table-tile:has(.label:text-is("T3"))');
  await pda.waitForTimeout(500);
  if (await pda.locator('button:has-text("+ Añadir consumición")').count()) await pda.click('button:has-text("+ Añadir consumición")');
  await pda.fill('input[placeholder="Buscar producto…"]', 'copa');
  for (let i = 0; i < 5; i++) {
    await pda.click('.product-btn:has-text("Copa de vino")');
    await pda.click('.modal .product-btn:has-text("Rioja")');
  }
  await pda.fill('input[placeholder="Buscar producto…"]', 'croq');
  await pda.click('.product-btn:has-text("Croquetas")');
  await pda.click('button:has-text("Enviar comanda")');
  await pda.waitForSelector('text=enviado');
  const after = (await get('/api/stock/items')).find((i) => i.name.startsWith('Vino Rioja')).stock;

  // 3. Cupón y cliente en la cuenta; cobro con ticket que muestra el descuento
  await pda.click('text=Cliente y cupón');
  await pda.fill('input[placeholder="Código de cupón"]', 'bienvenida');
  await pda.click('button:has-text("Aplicar cupón")');
  await pda.waitForSelector('text=Cupón BIENVENIDA');
  await pda.click('button:has-text("Todo entregado")');
  await pda.waitForTimeout(600);
  await pda.screenshot({ path: `${OUT}/f3-2-cuenta-cupon.png`, fullPage: true });
  await pda.click('button:has-text("Cobrar")');
  await pda.click('.modal .chip:has-text("Tarjeta")');
  await pda.click('button:has-text("Confirmar cobro")');
  await pda.waitForSelector('.doc');
  const ticket = await pda.locator('.doc').textContent();
  await pda.screenshot({ path: `${OUT}/f3-3-ticket-cupon.png` });

  // 4. Almacén: escandallo y rentabilidad
  await admin.click('a:has-text("Almacén y rentabilidad")');
  await admin.click('.chip:has-text("Escandallos")');
  await admin.selectOption('select >> nth=0', { label: 'Copa de vino' });
  await admin.waitForSelector('text=Coste según escandallo');
  await admin.screenshot({ path: `${OUT}/f3-4-escandallo.png`, fullPage: true });

  // 5. Carta del cliente en inglés
  const cli = await (await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage(); watch(cli, 'cliente');
  const tables = await get('/api/admin/tables');
  await cli.goto(`http://localhost:3000/carta/${tables[0].qr_token}`);
  await cli.waitForSelector('text=Homemade croquettes');
  await cli.screenshot({ path: `${OUT}/f3-5-carta-ingles.png` });

  // 6. Copias de seguridad: crear y verificar
  await admin.click('a:has-text("Copias de seguridad")');
  await admin.click('button:has-text("Crear copia ahora")');
  await admin.waitForSelector('td:has-text("Manual")');
  await admin.click('button:has-text("Restaurar…") >> nth=0');
  await admin.waitForSelector('text=Verificar copia');
  const verifyText = await admin.locator('.modal').textContent();
  await admin.screenshot({ path: `${OUT}/f3-6-copias.png` });

  // 7. Tarjeta digital
  const customers = await get('/api/loyalty/customers');
  const lucia = customers.find((c) => c.name === 'Lucía Martínez');
  const card = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 700 }, deviceScaleFactor: 2 })).newPage(); watch(card, 'tarjeta');
  await card.goto(`http://localhost:3000/tarjeta/${lucia.card_token}`);
  await card.waitForSelector('text=puntos');
  const cardText = await card.locator('body').textContent();

  console.log(JSON.stringify({
    mesaColocada: mesa1 && mesa1.pos_x != null,
    botellasDescontadas: Math.round((Number(before) - Number(after)) * 1000) / 1000,
    ticketConCupon: /Cupón BIENVENIDA/.test(ticket) && /Lucía/.test(ticket),
    puntosLucia: lucia.points,
    verificacionMuestraBloqueoOResumen: /lista de espera/.test(verifyText),
    tarjetaSinCuponUsado: !/BIENVENIDA/.test(cardText),
    errors,
  }, null, 1));
  await browser.close();
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
