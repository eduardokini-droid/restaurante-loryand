// Prueba de punta a punta de un servicio completo. Requiere el servidor en marcha con los datos de demostración recién cargados.
// Uso: node e2e/servicio-completo.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, n) => { p.on('pageerror', e => errors.push(`${n}: ${e.message}`)); p.on('console', m => m.type() === 'error' && errors.push(`${n} console: ${m.text()}`)); };
  // 1. Administrador
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 850 } })).newPage(); watch(admin, 'admin');
  await admin.goto('http://localhost:3000/gestion');
  await admin.fill('input[autocomplete=username]', 'admin');
  await admin.fill('input[type=password]', 'admin1234');
  await admin.click('button:has-text("Entrar")');
  await admin.waitForSelector('text=Mesas con cuenta abierta');
  // Datos de la mesa 2: token y clave
  const tables = await admin.evaluate(() => fetch('/api/admin/tables').then(r => r.json()));
  const t2 = tables.find(t => t.label === '2');
  // 2. Camarero en PDA (móvil)
  const pdaCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const pda = await pdaCtx.newPage(); watch(pda, 'pda');
  await pda.goto('http://localhost:3000/personal');
  await pda.fill('input >> nth=0', 'demo');
  await pda.fill('input >> nth=1', 'camarero-1');
  await pda.fill('input[type=password]', '1111');
  await pda.click('button:has-text("Entrar")');
  await pda.click('button:has-text("Fichar entrada")');
  await pda.waitForSelector('text=¿Dónde vas a atender?');
  // Clave de la mesa 2 desde la PDA
  await pda.click('.table-tile:has(.label:text-is("2"))');
  await pda.waitForSelector('text=Mesa 2 · nueva comanda');
  await pda.click('button:has-text("Ver clave")');
  const code = (await pda.locator('strong[style*="letter-spacing"]').textContent()).trim();
  // Camarero pide: croquetas (1.º pase) y entrecot (2.º pase)
  await pda.fill('input[placeholder="Buscar producto…"]', 'croq');
  await pda.click('.product-btn:has-text("Croquetas")');
  await pda.fill('input[placeholder="Buscar producto…"]', 'entrecot');
  await pda.click('.product-btn:has-text("Entrecot")');
  await pda.click('.product-btn:has-text("Al punto")');
  await pda.screenshot({ path: `${OUT}/2-pda-comanda.png`, fullPage: true });
  await pda.click('button:has-text("Enviar comanda")');
  await pda.waitForSelector('text=Pedido n.º 1 enviado');
  // 3. Cliente desde la carta (móvil) en la misma mesa
  const cli = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage(); watch(cli, 'cliente');
  await cli.goto(`http://localhost:3000/carta/${t2.qr_token}`);
  await cli.click('.chip:has-text("Bebidas")');
  await cli.click('section .card:has-text("Refresco")');
  await cli.click('.product-btn:has-text("Coca-Cola Zero")');
  await cli.screenshot({ path: `${OUT}/3-carta-cliente.png`, fullPage: false });
  await cli.click('button:has-text("Ver pedido")');
  await cli.click('button:has-text("Enviar pedido")');
  await cli.fill('input[aria-label="Clave de la mesa"]', code);
  await cli.click('button:has-text("Continuar")');
  await cli.waitForSelector('text=Pedido n.º 2 recibido');
  await cli.click('.chip:has-text("Quiero pagar")');
  // 4. Cocina
  const kit = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); watch(kit, 'cocina');
  await kit.goto('http://localhost:3000/gestion');
  await kit.fill('input[autocomplete=username]', 'cocina');
  await kit.fill('input[type=password]', 'cocina1234');
  await kit.click('button:has-text("Entrar")');
  await kit.waitForSelector('.ticket');
  await kit.screenshot({ path: `${OUT}/4-cocina.png` });
  const kitchenText = await kit.locator('.kds').textContent();
  if (kitchenText.includes('Entrecot')) errors.push('El 2.º pase no debería estar en cocina aún');
  await kit.click('button:has-text("Todo listo")');
  // Barra
  const bar = await (await browser.newContext()).newPage(); watch(bar, 'barra');
  await bar.goto('http://localhost:3000/gestion');
  await bar.fill('input[autocomplete=username]', 'barra'); await bar.fill('input[type=password]', 'barra1234');
  await bar.click('button:has-text("Entrar")');
  await bar.waitForSelector('.ticket:has-text("Coca-Cola Zero")');
  await bar.click('button:has-text("Todo listo")');
  // 5. Admin ve la sala con avisos (tiempo real)
  await admin.waitForSelector('.table-tile.alert');
  await admin.screenshot({ path: `${OUT}/1-sala-admin.png`, fullPage: true });
  // 6. Camarero: entrega, marcha 2.º pase
  await pda.waitForSelector('text=listos para servir');
  await pda.click('button:has-text("Entregado en mesa")');
  await pda.click('button:has-text("Marchar 2.º pase")');
  await pda.waitForSelector('text=2.º pase en marcha');
  await kit.waitForSelector('.ticket:has-text("Entrecot")');
  await kit.click('button:has-text("Todo listo")');
  await pda.waitForSelector('text=listos para servir');
  await pda.click('button:has-text("Entregado en mesa")');
  await pda.waitForTimeout(500);
  // 7. Cobro en efectivo con cambio
  await pda.click('button:has-text("Cobrar")');
  await pda.fill('input[placeholder="Opcional"]', '50');
  await pda.screenshot({ path: `${OUT}/5-pda-cobro.png` });
  await pda.click('button:has-text("Confirmar cobro")');
  await pda.waitForSelector('.doc');
  await pda.screenshot({ path: `${OUT}/6-ticket.png` });
  const ticket = await pda.locator('.doc').textContent();
  await pda.click('button[aria-label=Cerrar]');
  // 8. Caja
  await admin.click('a:has-text("Ventas y caja")');
  await admin.waitForSelector('text=Total cobrado');
  await admin.waitForTimeout(500);
  await admin.screenshot({ path: `${OUT}/7-caja.png`, fullPage: true });
  const caja = await admin.locator('.printable').textContent();
  console.log(JSON.stringify({ code, ticketHasTotal: /TOTAL/.test(ticket), ticket: ticket.slice(0, 400), caja: caja.slice(0, 300), errors }, null, 1));
  await browser.close();
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
