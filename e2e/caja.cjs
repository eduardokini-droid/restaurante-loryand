// Prueba en navegador de la caja: apertura con fondo, cobro en efectivo, salida, recuento por billetes y cierre Z.
// Uso: node e2e/caja.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
const fmt = (c) => `${(c / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true })} €`;
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const admin = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 950 }, deviceScaleFactor: 2 })).newPage();
    admin.on('pageerror', (e) => errors.push(e.message));
    admin.on('dialog', (d) => d.accept());
    await admin.goto('http://localhost:3000/gestion/caja');
    await admin.fill('input[autocomplete=username]', 'admin'); await admin.fill('input[type=password]', 'admin1234');
    await admin.click('button:has-text("Entrar")');
    await admin.waitForSelector('h3:has-text("Caja cerrada"), h3:has-text("Caja abierta")');
    if (await admin.locator('h3:has-text("Caja cerrada")').count()) {
      await admin.fill('label:has-text("Fondo de caja") input', '150');
      await admin.click('button:has-text("Abrir caja")');
    }
    await admin.waitForSelector('h3:has-text("Caja abierta")');

    // Cobro en efectivo desde la PDA (12,00 €: croquetas 9,50 + caña 2,50)
    const pda = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 } })).newPage();
    pda.on('dialog', (d) => d.accept());
    await pda.goto('http://localhost:3000/personal');
    await pda.fill('input >> nth=0', 'demo'); await pda.fill('input >> nth=1', 'camarero-1'); await pda.fill('input[type=password]', '1111');
    await pda.click('button:has-text("Entrar")');
    await pda.waitForSelector('h2:has-text("¿Dónde vas a atender?")');
    await pda.click('.table-tile:has(.label:text-is("3"))');
    await pda.waitForTimeout(500);
    if (await pda.locator('button:has-text("+ Añadir consumición")').count()) await pda.click('button:has-text("+ Añadir consumición")');
    await pda.fill('input[placeholder="Buscar producto…"]', 'croq'); await pda.click('.product-btn:has-text("Croquetas")');
    await pda.fill('input[placeholder="Buscar producto…"]', 'caña'); await pda.click('.product-btn:has-text("Caña")');
    await pda.click('button:has-text("Enviar comanda")');
    await pda.click('button:has-text("Todo entregado")');
    await pda.click('button:text-is("Cobrar")');
    await pda.fill('input[placeholder="Opcional"]', '20');
    await pda.click('button:has-text("Confirmar cobro")');
    await pda.waitForSelector('.doc');

    // Salida de 20 € para un proveedor
    await admin.waitForTimeout(1500);
    await admin.click('button:has-text("Salida de efectivo")');
    await admin.fill('.modal label:has-text("Importe") input', '20');
    await admin.fill('.modal label:has-text("Motivo") input', 'Pago al panadero');
    await admin.click('.modal button:has-text("Registrar")');
    await admin.waitForSelector('text=Pago al panadero');
    await admin.screenshot({ path: `${OUT}/caja-1-abierta.png` });

    // Lo que debería haber (incluye cobros hechos antes con la caja cerrada, que pasan a esta caja).
    const expected = await admin.evaluate(() => fetch('/api/cash/current').then((r) => r.json()).then((d) => d.summary.expectedCashCents));
    // Recuento con 50 céntimos de menos: 2 monedas de 0,20 y 1 de 0,10 menos de lo esperado.
    await admin.click('button:has-text("Cerrar caja")');
    const counted = expected - 50;
    await admin.fill('.modal label:has-text("O escribe el total contado") input', (counted / 100).toFixed(2).replace('.', ','));
    await admin.screenshot({ path: `${OUT}/caja-2-recuento.png` });
    await admin.click('.modal button:has-text("Cerrar caja")');
    await admin.waitForSelector('h2:has-text("Cierre Z")');
    const z = (await admin.locator('.modal').last().textContent()).replace(/[\u00a0\u202f]/g, ' ');
    await admin.screenshot({ path: `${OUT}/caja-3-cierre-z.png` });
    console.log(JSON.stringify({
      esperadoCorrecto: z.includes(`Debería haber${fmt(expected)}`),
      contadoCorrecto: z.includes(`Contado${fmt(counted)}`),
      descuadre: z.includes('Descuadre-0,50 €') || z.includes('Descuadre−0,50 €'),
      errors,
    }, null, 1));
  } finally { await browser.close(); }
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
