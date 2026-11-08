// Prueba en navegador de la fase 2: lista de espera, reservas (formulario público), menú del día y factura completa.
// Ejecutar después de servicio-completo.cjs (usa su ticket). Uso: node e2e/fase2.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, n) => { p.on('pageerror', e => errors.push(`${n}: ${e.message}`)); };
  const admin = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage(); watch(admin, 'admin');
  await admin.goto('http://localhost:3000/gestion');
  await admin.fill('input[autocomplete=username]', 'admin'); await admin.fill('input[type=password]', 'admin1234');
  await admin.click('button:has-text("Entrar")');
  await admin.waitForSelector('text=Mesas con cuenta abierta');

  // 1. Lista de espera: A(6), B(2), C(4)
  await admin.click('a:has-text("Lista de espera")');
  for (const [name, n] of [['Familia García', 6], ['Pareja López', 2], ['Amigos Ruiz', 4]]) {
    await admin.click('button:has-text("+ Añadir grupo")');
    await admin.fill('.modal input >> nth=0', name);
    await admin.fill('.modal input[type=number]', String(n));
    await admin.click('.modal button:has-text("Añadir")');
    await admin.waitForSelector(`text=${name}`);
  }
  await admin.waitForTimeout(600);
  await admin.screenshot({ path: `${OUT}/f2-1-lista-espera.png`, fullPage: true });
  const waitText = await admin.locator('main').textContent();
  await admin.click('button:has-text("y marcar avisado") >> nth=0');
  await admin.waitForSelector('text=Avisados');

  // 2. Formulario público de reservas
  const cli = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage(); watch(cli, 'reserva');
  await cli.goto('http://localhost:3000/reservar/demo');
  await cli.fill('input[type=number]', '4');
  await cli.selectOption('select >> nth=0', '21:00');
  await cli.fill('input[autocomplete=name]', 'Marta Sanz');
  await cli.fill('input[autocomplete=tel]', '600123123');
  await cli.screenshot({ path: `${OUT}/f2-2-reservar.png`, fullPage: true });
  await cli.click('button:has-text("Solicitar reserva")');
  await cli.waitForSelector('text=Todavía no está confirmada');
  await admin.click('a:has-text("Reservas")');
  await admin.click('button:has-text("→")');
  await admin.waitForSelector('text=Marta Sanz');
  await admin.selectOption('tr:has-text("Marta Sanz") select', { label: 'T1 (4 pl.)' });
  await admin.waitForTimeout(400);
  await admin.click('tr:has-text("Marta Sanz") button:has-text("Confirmar")');
  await admin.waitForSelector('tr:has-text("Marta Sanz") >> text=Confirmada');
  await admin.screenshot({ path: `${OUT}/f2-3-reservas.png`, fullPage: true });

  // 3. Menú del día desde la PDA
  const pda = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage(); watch(pda, 'pda');
  await pda.goto('http://localhost:3000/personal');
  await pda.fill('input >> nth=0', 'demo'); await pda.fill('input >> nth=1', 'camarero-2'); await pda.fill('input[type=password]', '2222');
  await pda.click('button:has-text("Entrar")');
  await pda.waitForSelector('button:has-text("Fichar entrada"), h2:has-text("¿Dónde vas a atender?")');
  if (await pda.locator('button:has-text("Fichar entrada")').count()) await pda.click('button:has-text("Fichar entrada")');
  await pda.click('.table-tile:has(.label:text-is("T2"))');
  await pda.click('.chip:has-text("Menú del día")');
  for (const o of ['Gazpacho', 'Albóndigas', 'Flan', 'Agua']) await pda.click(`.modal .chip:has-text("${o}")`);
  await pda.screenshot({ path: `${OUT}/f2-4-menu-pda.png` });
  await pda.click('button:has-text("Añadir menú")');
  await pda.click('button:has-text("Enviar comanda")');
  await pda.waitForSelector('text=enviado');
  await pda.waitForSelector('text=Menú');
  const kitchen = await admin.evaluate(() => fetch('/api/kds/kitchen').then(r => r.json()));
  const kitchenItems = kitchen.flatMap(t => t.items.map(i => i.name));

  // 4. Factura completa desde el ticket de la prueba anterior
  await admin.click('a:has-text("Ventas y caja")');
  await admin.waitForSelector('text=Registro documental');
  await admin.click('tr:has-text("Factura simplificada") >> nth=0');
  await admin.click('button:has-text("Factura completa…")');
  const m = admin.locator('.modal').last();
  await m.locator('input').nth(0).fill('Hostelería Ejemplo S.L.');
  await m.locator('input').nth(1).fill('B12345678');
  await m.locator('input').nth(2).fill('Calle Mayor 5');
  await m.locator('input').nth(4).fill('Madrid');
  await m.locator('button:has-text("Emitir factura completa")').click();
  await admin.waitForSelector('.doc:has-text("Hostelería Ejemplo")');
  await admin.screenshot({ path: `${OUT}/f2-5-factura.png` });
  await admin.click('.modal button[aria-label=Cerrar]');
  await admin.waitForTimeout(300);
  await admin.click('button:has-text("Consultar")');
  await admin.waitForSelector('text=Control de camareros');
  await admin.waitForTimeout(600);
  await admin.screenshot({ path: `${OUT}/f2-6-caja.png`, fullPage: true });

  console.log(JSON.stringify({
    propuestaParejaMesa1: /Pareja López[\s\S]*Propuesta: Mesa 1/.test(waitText),
    familiaMesaMasAjustada: /Familia García[\s\S]*Propuesta: Mesa 4 \(6 pl\.\)/.test(waitText),
    cocinaRecibePrimero: kitchenItems.includes('Gazpacho') && !kitchenItems.includes('Albóndigas'),
    errors,
  }, null, 1));
  await browser.close();
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
