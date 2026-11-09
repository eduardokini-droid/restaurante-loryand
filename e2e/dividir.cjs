// Prueba en navegador: cambiar de mesa y dividir la cuenta por productos (cada uno su ticket).
// Uso: node e2e/dividir.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const pda = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 })).newPage();
    pda.on('pageerror', (e) => errors.push(e.message));
    pda.on('dialog', (d) => d.accept());
    await pda.goto('http://localhost:3000/personal');
    await pda.fill('input >> nth=0', 'demo'); await pda.fill('input >> nth=1', 'camarero-2'); await pda.fill('input[type=password]', '2222');
    await pda.click('button:has-text("Entrar")');
    await pda.waitForSelector('h2:has-text("¿Dónde vas a atender?")');
    await pda.click('.table-tile:has(.label:text-is("T3"))');
    await pda.waitForTimeout(500);
    if (await pda.locator('button:has-text("+ Añadir consumición")').count()) await pda.click('button:has-text("+ Añadir consumición")');
    await pda.fill('input[placeholder="Buscar producto…"]', 'bravas');
    await pda.click('.product-btn:has-text("Patatas bravas")'); await pda.click('.product-btn:has-text("Patatas bravas")');
    await pda.fill('input[placeholder="Buscar producto…"]', 'caña');
    await pda.click('.product-btn:has-text("Caña")'); await pda.click('.product-btn:has-text("Caña")');
    await pda.click('button:has-text("Enviar comanda")');
    await pda.waitForSelector('button:has-text("Cambiar de mesa")');
    // Cambian de mesa: de T3 (2 plazas) a la 4
    await pda.click('button:has-text("Cambiar de mesa")');
    await pda.click('.modal .table-tile:has(.label:text-is("4"))');
    await pda.waitForSelector('text=Cuenta pasada a la mesa 4');
    await pda.waitForSelector('h2:has-text("¿Dónde vas a atender?")');
    const t3 = await pda.locator('.table-tile:has(.label:text-is("T3"))').textContent();
    await pda.click('.table-tile:has(.label:text-is("4"))');
    await pda.waitForSelector('h2:has-text("Mesa 4")');
    await pda.click('button:has-text("Todo entregado")');
    // Persona A: unas bravas y una caña (6,50 + 2,50 = 9,00)
    await pda.click('button:text-is("Cobrar")');
    await pda.click('.modal .chip:has-text("Por productos")');
    await pda.click('.modal .ticket-line:has-text("Patatas bravas") button[aria-label="Más"]');
    await pda.click('.modal .ticket-line:has-text("Caña") button[aria-label="Más"]');
    await pda.click('.modal .chip:has-text("Tarjeta")');
    await pda.screenshot({ path: `${OUT}/div-1-por-productos.png` });
    const paga = await pda.locator('.modal').textContent();
    await pda.click('.modal button:has-text("Confirmar cobro")');
    await pda.waitForSelector('.doc');
    const ticketA = await pda.locator('.doc').textContent();
    await pda.screenshot({ path: `${OUT}/div-2-ticket-persona-a.png` });
    await pda.click('.modal button[aria-label=Cerrar]');
    // Persona B: el resto
    await pda.click('button:text-is("Cobrar")');
    await pda.click('.modal button:has-text("Confirmar cobro")');
    await pda.waitForSelector('.doc');
    const lastTicket = await pda.locator('.doc').textContent();
    await pda.screenshot({ path: `${OUT}/div-3-ticket-final.png` });
    const docs = await pda.evaluate(async () => {
      const f = await fetch('/api/service/floor').then((r) => r.json());
      return f.tables.find((t) => t.label === '4');
    });
    console.log(JSON.stringify({
      mesaViejaPendienteLimpiar: /Pendiente de limpiar/.test(t3),
      ticketPersonaA: ticketA.includes('1 Patatas bravas') && ticketA.includes('1 Caña') && !ticketA.includes('2 Patatas'),
      personaApaga9: paga.replace(/ /g, ' ').includes('Paga esta persona9,00 €'),
      ticketFinalSoloResto: lastTicket.includes('1 Patatas bravas') && lastTicket.includes('1 Caña') && lastTicket.replace(/ /g, ' ').includes('9,00 €'),
      mesa4Pagada: docs.physical_state === 'paid_occupied',
      errors,
    }, null, 1));
  } finally { await browser.close(); }
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
