// Prueba en navegador de la impresión: configuración desde el panel, agente real e impresora de red simulada.
// Uso: node e2e/impresion.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const OUT = process.argv[2];
(async () => {
  const received = [];
  const printer = net.createServer((s) => { const parts = []; s.on('data', (d) => parts.push(d)); s.on('end', () => received.push(Buffer.concat(parts).toString('latin1'))); });
  await new Promise((r) => printer.listen(9910, '127.0.0.1', r));
  const browser = await chromium.launch();
  const errors = [];
  let agent;
  try {
    const admin = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage();
    admin.on('pageerror', (e) => errors.push(e.message));
    admin.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'PC de barra' : undefined));
    await admin.goto('http://localhost:3000/gestion');
    await admin.fill('input[autocomplete=username]', 'admin'); await admin.fill('input[type=password]', 'admin1234');
    await admin.click('button:has-text("Entrar")');
    await admin.waitForSelector('text=Mesas con cuenta abierta');
    await admin.click('a:has-text("Impresoras")');
    await admin.click('button:has-text("Nuevo agente")');
    const token = (await admin.locator('.modal code').textContent()).trim();
    await admin.click('.modal button[aria-label=Cerrar]');
    for (const [name, role] of [['Cocina', 'Comandas de cocina'], ['Barra y caja', 'Comandas de barra']]) {
      await admin.click('button:has-text("+ Añadir impresora")');
      await admin.fill('.modal input >> nth=0', name);
      await admin.fill('.modal input >> nth=1', '127.0.0.1:9910');
      if (name !== 'Cocina') { await admin.locator('.modal label:has-text("Comandas de cocina") input').uncheck(); await admin.locator(`.modal label:has-text("${role}") input`).check(); await admin.locator('.modal label:has-text("Tickets y facturas") input').check(); }
      await admin.click('.modal button:has-text("Guardar")');
      await admin.waitForSelector(`td:has-text("${name}")`);
    }
    agent = spawn(process.execPath, [path.resolve(__dirname, '../agent/agente.mjs')], { env: { ...process.env, LORYAND_SERVER: 'http://localhost:3000', LORYAND_TOKEN: token }, stdio: 'ignore' });
    await admin.click('tr:has-text("Cocina") button:has-text("Imprimir prueba")');
    for (let i = 0; i < 60 && received.length < 1; i++) await new Promise((r) => setTimeout(r, 100));
    await admin.waitForSelector('text=Conectado', { timeout: 10000 });
    await admin.waitForTimeout(2500);
    await admin.screenshot({ path: `${OUT}/imp-1-impresoras.png`, fullPage: true });

    // Comanda desde la PDA → cocina y barra
    const pda = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 } })).newPage();
    pda.on('dialog', (d) => d.accept());
    await pda.goto('http://localhost:3000/personal');
    await pda.fill('input >> nth=0', 'demo'); await pda.fill('input >> nth=1', 'camarero-2'); await pda.fill('input[type=password]', '2222');
    await pda.click('button:has-text("Entrar")');
    await pda.waitForSelector('button:has-text("Fichar entrada"), h2:has-text("¿Dónde vas a atender?")');
    if (await pda.locator('button:has-text("Fichar entrada")').count()) await pda.click('button:has-text("Fichar entrada")');
    await pda.click('.table-tile:has(.label:text-is("4"))');
    await pda.waitForTimeout(500);
    if (await pda.locator('button:has-text("+ Añadir consumición")').count()) await pda.click('button:has-text("+ Añadir consumición")');
    await pda.fill('input[placeholder="Buscar producto…"]', 'croq');
    await pda.click('.product-btn:has-text("Croquetas")');
    await pda.fill('input[placeholder="Buscar producto…"]', 'caña');
    await pda.click('.product-btn:has-text("Caña")');
    await pda.fill('input[placeholder="Nota para cocina/barra (opcional)"]', 'Sin gluten, alergia');
    await pda.click('button:has-text("Enviar comanda")');
    for (let i = 0; i < 80 && received.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    // Cobro y ticket en la impresora de caja
    await pda.click('button:has-text("Todo entregado")');
    await pda.click('button:text-is("Cobrar")');
    await pda.click('button:has-text("Confirmar cobro")');
    await pda.waitForSelector('.doc');
    await pda.click('.modal button:has-text("Imprimir ticket")');
    for (let i = 0; i < 80 && received.length < 4; i++) await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(`${OUT}/imp-comanda-cocina.txt`, (received[1] || '').replace(/[\x00-\x09\x0b-\x1f]/g, ''));
    console.log(JSON.stringify({
      trabajosRecibidos: received.length,
      prueba: /PRUEBA/.test(received[0] || '') && received[0].includes('\xa4'),
      comandaCocina: received.some((r) => r.includes('COCINA') && r.includes('Croquetas') && r.includes('NOTA: Sin gluten')),
      comandaBarra: received.some((r) => r.includes('BARRA') && r.includes('Ca\xa4a')),
      ticket: received.some((r) => r.includes('FACTURA SIMPLIFICADA')),
      errors,
    }, null, 1));
  } finally {
    agent?.kill();
    printer.close();
    await browser.close();
  }
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
