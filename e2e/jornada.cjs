// Prueba en navegador del registro de jornada: cocinero que solo ficha (con pausa), corrección con motivo,
// historial, exportación CSV y hoja mensual. Uso: node e2e/jornada.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const admin = await (await browser.newContext({ locale: 'es-ES', timezoneId: 'Europe/Madrid', viewport: { width: 1280, height: 950 }, deviceScaleFactor: 2, acceptDownloads: true })).newPage();
    admin.on('pageerror', (e) => errors.push(e.message));
    admin.on('dialog', (d) => d.accept());
    await admin.goto('http://localhost:3000/gestion/camareros');
    await admin.fill('input[autocomplete=username]', 'admin'); await admin.fill('input[type=password]', 'admin1234');
    await admin.click('button:has-text("Entrar")');
    await admin.waitForSelector('h1:has-text("Personal y claves")');
    // Alta de un cocinero
    const cardRow = admin.locator('.card.row');
    await cardRow.locator('input[placeholder="Nombre"]').fill('Pepe Cocina');
    await cardRow.locator('input[placeholder="PIN (4 a 6 cifras)"]').fill('7777');
    await cardRow.locator('select').selectOption('cocina');
    await cardRow.locator('input[placeholder="DNI/NIE (opcional)"]').fill('12345678z');
    await cardRow.locator('button:has-text("Crear")').click();
    await admin.waitForSelector('text=Pepe Cocina');
    const username = await admin.locator('tr:has-text("Pepe Cocina") code').first().textContent();

    // El cocinero ficha desde su móvil: solo ve la pantalla de fichaje
    const pepe = await (await browser.newContext({ locale: 'es-ES', timezoneId: 'Europe/Madrid', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
    pepe.on('dialog', (d) => d.accept());
    await pepe.goto('http://localhost:3000/personal');
    await pepe.fill('input >> nth=0', 'demo'); await pepe.fill('input >> nth=1', username); await pepe.fill('input[type=password]', '7777');
    await pepe.click('button:has-text("Entrar")');
    await pepe.waitForSelector('h2:has-text("Trabajando")');
    const sinComandas = (await pepe.locator('text=¿Dónde vas a atender?').count()) === 0;
    await pepe.click('button:has-text("Iniciar pausa")');
    await pepe.waitForSelector('h2:has-text("En pausa")');
    await pepe.screenshot({ path: `${OUT}/jor-1-movil-pausa.png` });
    await pepe.click('.card button:has-text("Fin de pausa")');
    await pepe.waitForSelector('h2:has-text("Trabajando")');
    await pepe.click('.card button:has-text("Fichar salida")');
    await pepe.waitForSelector('h2:has-text("Fuera de turno")');

    // Encargado: añade un fichaje olvidado de ayer y lo corrige
    await admin.click('a:has-text("Registro de jornada")');
    await admin.waitForSelector('h1:has-text("Registro de jornada")');
    await admin.click('button:has-text("Mes anterior")');
    await admin.click('button:has-text("Este mes")');
    await admin.click('button:has-text("+ Añadir fichaje olvidado")');
    const y = new Date(Date.now() - 86400000); const d = y.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    await admin.selectOption('.modal select', { label: 'Pepe Cocina' });
    await admin.fill('.modal label:has-text("Entrada") input', `${d}T09:00`);
    await admin.fill('.modal label:has-text("Salida") input', `${d}T17:00`);
    await admin.fill('.modal label:has-text("Motivo") input', 'Olvidó fichar; confirmado con él');
    await admin.click('.modal button:has-text("Guardar")');
    await admin.waitForSelector('tr:has-text("Pepe Cocina") >> text=8 h 00 min');
    await admin.click('tr:has-text("8 h 00 min") button:has-text("Corregir")');
    await admin.fill('.modal label:has-text("Salida") input', `${d}T18:30`);
    await admin.fill('.modal label:has-text("Motivo") input', 'Se quedó a cerrar la cocina');
    await admin.click('.modal button:has-text("Guardar")');
    await admin.waitForSelector('text=9 h 30 min');
    await admin.click('tr:has-text("9 h 30 min") button:has-text("Historial")');
    await admin.waitForSelector('.modal >> text=Se quedó a cerrar la cocina');
    const hist = await admin.locator('.modal').textContent();
    await admin.screenshot({ path: `${OUT}/jor-2-historial.png` });
    await admin.click('.modal button[aria-label=Cerrar]');
    await admin.screenshot({ path: `${OUT}/jor-3-registro.png`, fullPage: true });
    // Exportación
    const [dl] = await Promise.all([admin.waitForEvent('download'), admin.click('button:has-text("Exportar a Excel")')]);
    const csv = require('fs').readFileSync(await dl.path(), 'utf8');
    // Hoja mensual de Pepe
    await admin.selectOption('label:has-text("Trabajador") select', { label: 'Pepe Cocina · Cocina' });
    await admin.click('button:has-text("Hoja mensual para firmar")');
    await admin.waitForSelector('text=Firma del trabajador');
    await admin.screenshot({ path: `${OUT}/jor-4-hoja.png` });
    console.log(JSON.stringify({
      cocineroSoloFicha: sinComandas,
      historialConAnterior: hist.includes('Antes: 09:00 → 17:00') && hist.includes('Después: 09:00 → 18:30'),
      csvConDniYCorreccion: csv.includes('Pepe Cocina;12345678Z;Cocina;09:00;18:30;0;9:30;Corregido'),
      errors,
    }, null, 1));
  } finally { await browser.close(); }
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
