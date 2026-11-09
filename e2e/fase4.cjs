// Prueba en navegador de pagos online (Redsys simulado) y avisos por WhatsApp en modo enlace.
// La pasarela del banco se intercepta y su notificación se simula con la clave pública de pruebas.
// Uso: node e2e/fase4.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const crypto = require('crypto');
const OUT = process.argv[2];
const KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
function sign(order, params) {
  const data = Buffer.alloc(Math.ceil(order.length / 8) * 8, 0); Buffer.from(order).copy(data);
  const c = crypto.createCipheriv('des-ede3-cbc', Buffer.from(KEY, 'base64'), Buffer.alloc(8, 0)); c.setAutoPadding(false);
  const k = Buffer.concat([c.update(data), c.final()]);
  return crypto.createHmac('sha256', k).update(params).digest('base64');
}
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, n) => p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
  const admin = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage(); watch(admin, 'admin');
  admin.on('dialog', (d) => d.accept());
  await admin.goto('http://localhost:3000/gestion');
  await admin.fill('input[autocomplete=username]', 'admin'); await admin.fill('input[type=password]', 'admin1234');
  await admin.click('button:has-text("Entrar")');
  await admin.waitForSelector('text=Mesas con cuenta abierta');

  // 1. Configurar Redsys (pruebas) y WhatsApp (modo enlace)
  await admin.click('a:has-text("Pagos y WhatsApp")');
  await admin.click('button:has-text("Rellenar con los datos públicos")');
  await admin.locator('.card').nth(0).locator('label:has-text("Bizum") input').check();
  await admin.locator('.card').nth(0).locator('label:has-text("Habilitar cobro online") input').check();
  await admin.locator('.card').nth(0).locator('button:has-text("Guardar")').click();
  await admin.waitForSelector('text=Activo · pruebas');
  await admin.locator('.card').nth(1).locator('label:has-text("Activar avisos") input').check();
  await admin.locator('.card').nth(1).locator('button:has-text("Guardar")').click();
  await admin.waitForSelector('.card >> nth=1 >> text=Activos');
  await admin.screenshot({ path: `${OUT}/f4-1-config.png`, fullPage: true });

  // 2. Camarero: comanda y "Cobrar con QR"
  const pda = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage(); watch(pda, 'pda');
  pda.on('dialog', (d) => d.accept());
  await pda.goto('http://localhost:3000/personal');
  await pda.fill('input >> nth=0', 'demo'); await pda.fill('input >> nth=1', 'camarero-1'); await pda.fill('input[type=password]', '1111');
  await pda.click('button:has-text("Entrar")');
  await pda.waitForSelector('button:has-text("Fichar entrada"), h2:has-text("¿Dónde vas a atender?")');
  if (await pda.locator('button:has-text("Fichar entrada")').count()) await pda.click('button:has-text("Fichar entrada")');
  await pda.click('.table-tile:has(.label:text-is("T1"))');
  await pda.waitForTimeout(400);
  if (await pda.locator('button:has-text("+ Añadir consumición")').count()) await pda.click('button:has-text("+ Añadir consumición")');
  await pda.fill('input[placeholder="Buscar producto…"]', 'bravas');
  await pda.click('.product-btn:has-text("Patatas bravas")');
  await pda.click('.product-btn:has-text("Patatas bravas")');
  await pda.click('button:has-text("Enviar comanda")');
  await pda.waitForSelector('button:has-text("Cobrar con QR")');
  await pda.click('button:has-text("Cobrar con QR")');
  await pda.waitForSelector('img[alt="QR de pago"]');
  await pda.screenshot({ path: `${OUT}/f4-2-qr-pda.png` });
  const payUrl = await pda.evaluate(async () => {
    const accs = await fetch('/api/service/floor').then((r) => r.json());
    const t = accs.tables.find((x) => x.label === 'T1');
    const list = await fetch(`/api/service/accounts/${t.account_id}/online-payments`).then((r) => r.json());
    return `/pagar/${list[0].token}`;
  });

  // 3. Cliente: página de pago → Bizum → (pasarela interceptada)
  const cli = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage(); watch(cli, 'cliente');
  let bankPost = null;
  await cli.route('https://sis-t.redsys.es:25443/**', async (route) => {
    bankPost = Object.fromEntries(new URLSearchParams(route.request().postData() || ''));
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Pasarela simulada del banco</h1>' });
  });
  await cli.goto(`http://localhost:3000${payUrl}`);
  await cli.waitForSelector('text=Importe a pagar');
  await cli.screenshot({ path: `${OUT}/f4-3-pagar.png` });
  await cli.click('button:has-text("Pagar con Bizum")');
  await cli.waitForSelector('text=Pasarela simulada');
  const sent = JSON.parse(Buffer.from(bankPost.Ds_MerchantParameters, 'base64').toString());

  // 4. El banco notifica el pago autorizado
  const params = Buffer.from(JSON.stringify({ Ds_Order: sent.DS_MERCHANT_ORDER, Ds_Amount: sent.DS_MERCHANT_AMOUNT, Ds_Response: '0000', Ds_AuthorisationCode: '987654' })).toString('base64');
  const notify = await fetch('http://localhost:3000/api/redsys/notify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: params, Ds_Signature: sign(sent.DS_MERCHANT_ORDER, params) }).toString() });
  const notifyBody = await notify.text();
  await pda.waitForSelector('text=Pagado', { timeout: 15000 });
  await pda.screenshot({ path: `${OUT}/f4-4-pagado.png` });
  await cli.goto(`http://localhost:3000${payUrl}?resultado=ok`);
  await cli.waitForSelector('text=Pago confirmado por el banco');
  await cli.screenshot({ path: `${OUT}/f4-5-confirmado.png` });

  // 5. WhatsApp: confirmar una solicitud de reserva prepara el mensaje
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await fetch('http://localhost:3000/api/public/booking/demo', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Carmen Ruiz', phone: '600 555 444', partySize: 3, date: tomorrow, time: '21:00', acceptPrivacy: true, whatsappConsent: true }) });
  await admin.click('a:has-text("Reservas")');
  await admin.click('button:has-text("→")');
  await admin.click('tr:has-text("Carmen Ruiz") button:has-text("Confirmar")');
  await admin.waitForSelector('text=Avisar por WhatsApp');
  const waHref = await admin.locator('a:has-text("Abrir WhatsApp")').getAttribute('href');
  await admin.screenshot({ path: `${OUT}/f4-6-whatsapp.png` });

  console.log(JSON.stringify({
    pasarelaPruebas: !!bankPost && sent.DS_MERCHANT_PAYMETHODS === 'z' && sent.DS_MERCHANT_AMOUNT === '1300',
    notificacion: notifyBody,
    enlaceWhatsApp: waHref.startsWith('https://wa.me/34600555444?text=Hola%20Carmen'),
    errors,
  }, null, 1));
  await browser.close();
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
