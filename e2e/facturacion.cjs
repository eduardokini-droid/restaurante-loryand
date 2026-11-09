// Facturación de Loryand e incidencias: emisor, contrato, cuotas del mes, factura imprimible, cobro,
// vista del cliente e incidencia con respuesta. Uso: node e2e/facturacion.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = async (opts = {}) => {
    const p = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1240, height: 880 }, acceptDownloads: true, ...opts })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && !/status of 40[13]/.test(m.text()) && errors.push(m.text()));
    return p;
  };
  const login = async (p, u, pw) => {
    await p.goto('http://localhost:3000/gestion');
    await p.fill('input[autocomplete=username]', u);
    await p.fill('input[type=password]', pw);
    await p.click('button:has-text("Entrar")');
  };
  const g = await page({ deviceScaleFactor: 2 });
  await login(g, 'gestor', 'gestor1234');
  await g.waitForSelector('text=Gestor general · Loryand');

  // 1. Datos del emisor.
  await g.click('button.chip:has-text("Datos de facturación")');
  const f = (l) => g.locator(`label:has-text("${l}") input`).first();
  await f('Razón social o nombre').fill('Loryand Soluciones S.L.');
  await f('NIF').fill('B99999999');
  await f('Dirección').fill('C/ Tecnología 1');
  await f('Código postal').fill('45001');
  await f('Localidad').fill('Toledo');
  await f('Correo').fill('facturas@loryand.es');
  await f('IBAN').fill('ES91 2100 0418 4502 0005 1332');
  await g.click('button:has-text("Guardar")');
  await g.waitForSelector('text=Datos de facturación guardados');

  // 2. Contrato del local de demostración.
  await g.click('button.chip:has-text("Clientes")');
  await g.click('tr:has-text("Casa Demo") button:has-text("Contrato")');
  await g.fill('.modal label:has-text("Plan") input', 'Plan TPV completo');
  await g.fill('.modal label:has-text("Cuota mensual") input', '49,00');
  await g.fill('.modal label:has-text("Razón social") input', 'Casa Demo Hostelería S.L.');
  await g.fill('.modal label:has-text("NIF / CIF") input', 'B12345678');
  await g.fill('.modal label:has-text("Dirección fiscal") input', 'C/ Mayor 12, 45001 Toledo');
  await g.click('.modal button:has-text("Guardar contrato")');
  await g.waitForSelector('tr:has-text("Casa Demo"):has-text("Plan TPV completo")');
  await g.waitForSelector('text=59,29');  // 49 € + 21 % en la tarjeta de cuotas al mes

  // 3. Cuotas del mes y factura.
  await g.click('button.chip:has-text("Facturas")');
  await g.click('button:has-text("Emitir cuotas de")');
  await g.waitForSelector('text=1 factura emitida');
  await g.waitForSelector('tr:has-text("Casa Demo"):has-text("59,29")');
  const code = (await g.locator('tr:has-text("Casa Demo") code').first().textContent()).trim();
  await g.screenshot({ path: `${OUT}/fact-1-facturas.png` });
  await g.click('tr:has-text("Casa Demo") a:has-text("Ver")');
  await g.waitForSelector(`text=${code}`);
  await g.waitForSelector('text=Casa Demo Hostelería S.L.');
  await g.screenshot({ path: `${OUT}/fact-2-factura.png`, fullPage: true });
  await g.goBack();
  await g.click('button.chip:has-text("Facturas")');
  await g.click('tr:has-text("Casa Demo") button:has-text("Cobrada")');
  await g.waitForSelector('tr:has-text("Casa Demo") .badge:has-text("Cobrada")');
  const [dl] = await Promise.all([g.waitForEvent('download'), g.click('button:has-text("Libro de facturas")')]);
  if (!require('fs').readFileSync(await dl.path(), 'utf8').includes(code)) throw new Error('El libro no incluye la factura');

  // 4. El cliente ve su factura y abre una incidencia.
  const a = await page();
  await login(a, 'admin', 'admin1234');
  await a.waitForSelector('text=Mesas con cuenta abierta');
  await a.click('nav a:has-text("Suscripción y soporte")');
  await a.waitForSelector('text=Plan TPV completo');
  await a.waitForSelector(`tr:has-text("${code}") .badge:has-text("Pagada")`);
  await a.click('button:has-text("+ Avisar a Loryand")');
  await a.fill('.modal label:has-text("Asunto") input', 'No imprime la cocina');
  await a.selectOption('.modal label:has-text("Tipo") select', 'hardware');
  await a.selectOption('.modal label:has-text("Urgencia") select', 'high');
  await a.fill('.modal textarea', 'Desde esta mañana no sale nada por la impresora de cocina.');
  await a.click('.modal button:has-text("Enviar")');
  await a.waitForSelector('tr:has-text("No imprime la cocina")');
  await a.screenshot({ path: `${OUT}/fact-3-cliente.png`, fullPage: true });

  // 5. El gestor responde.
  await g.click('button.chip:has-text("Incidencias")');
  await g.click('tr:has-text("No imprime la cocina")');
  await g.waitForSelector('.modal >> text=Desde esta mañana');
  await g.fill('.modal textarea', 'Reinicia el agente de impresión desde el PC de la caja, por favor.');
  await g.click('.modal button:has-text("Enviar")');
  await g.waitForSelector('.modal >> text=Reinicia el agente');
  await g.screenshot({ path: `${OUT}/fact-4-incidencia.png` });
  await a.reload();
  await a.waitForSelector('tr:has-text("No imprime la cocina") >> text=Respuesta nueva');
  await a.click('tr:has-text("No imprime la cocina")');
  await a.waitForSelector('.modal >> text=Reinicia el agente');

  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log(`Facturación OK (${code})`);
})().catch((e) => { console.error(e); process.exit(1); });
