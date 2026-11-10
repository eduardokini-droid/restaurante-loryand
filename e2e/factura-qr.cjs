// Ticket con logotipo y QR; el cliente pide su factura completa desde el móvil.
// Uso: node e2e/factura-qr.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2];
function png(size, [r, g, b]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = y * (size * 4 + 1) + 1 + x * 4; const inside = (x - size / 2) ** 2 + (y - size / 2) ** 2 < (size * 0.45) ** 2;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = inside ? 255 : 0;
  }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([l, td, c]); };
  const h = Buffer.alloc(13); h.writeUInt32BE(size, 0); h.writeUInt32BE(size, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
(async () => {
  const logoFile = path.join(OUT, 'logo-qr.png'); fs.writeFileSync(logoFile, png(400, [60, 87, 61]));
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/status of 40[01]/.test(m.text()) && errors.push(m.text())); };
  const a = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 860 } })).newPage(); watch(a);
  await a.goto('http://localhost:3000/gestion');
  await a.fill('input[autocomplete=username]', 'admin'); await a.fill('input[type=password]', 'admin1234');
  await a.click('button:has-text("Entrar")');
  await a.waitForSelector('text=Mesas con cuenta abierta');
  await a.click('nav a:has-text("Datos del negocio")');
  await a.setInputFiles('label:has-text("logotipo") input[type=file]', logoFile);
  await a.waitForSelector('text=Logotipo guardado');
  const printLogo = await a.evaluate(() => fetch('/api/admin/establishment').then((r) => r.json()).then((e) => e.logo_print_width));
  if (!(printLogo > 0)) throw new Error('No se generó el logotipo para la impresora');
  // Venta rápida y ticket en pantalla con logotipo y QR.
  await a.click('nav a:has-text("TPV")');
  await a.click('button:has-text("Venta rápida")');
  await a.fill('input[placeholder="Buscar producto…"]', 'croq');
  await a.click('.product-btn:has-text("Croquetas")');
  await a.click('.chip:has-text("Tarjeta")');
  await a.click('button:has-text("Cobrar 9,50")');
  await a.click('button:has-text("Ver ticket")');
  await a.waitForSelector('.modal img[alt="QR para pedir la factura completa"]');
  await a.waitForSelector('.modal .doc img[src^="/api/img/"]');
  await a.screenshot({ path: `${OUT}/fqr-1-ticket.png` });
  const tk = require('child_process').execFileSync('psql', [process.env.DATABASE_URL ?? 'postgres://loryand:loryand@localhost:5432/loryand', '-tAc',
    "select public_token from documents where type = 'simplified' order by created_at desc limit 1"]).toString().trim();
  // Cliente en el móvil.
  const m = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage(); watch(m);
  await m.goto(`http://localhost:3000/factura/${tk}`);
  await m.waitForSelector('text=Pedir factura completa');
  await m.fill('label:has-text("Nombre o razón social") input', 'Distribuciones Ruiz S.L.');
  await m.fill('label:has-text("NIF, NIE o CIF") input', 'B12345675');
  await m.fill('label:has-text("Dirección") input', 'C/ Sol 2');
  await m.fill('label:has-text("Código postal") input', '45001');
  await m.fill('label:has-text("Localidad") input', 'Toledo');
  await m.screenshot({ path: `${OUT}/fqr-2-formulario.png`, fullPage: true });
  await m.click('button:has-text("Emitir mi factura")');
  await m.waitForSelector('text=no es correcto');
  await m.fill('label:has-text("NIF, NIE o CIF") input', 'B12345674');
  await m.click('button:has-text("Emitir mi factura")');
  await m.waitForSelector('text=Distribuciones Ruiz S.L.');
  await m.waitForSelector('text=FACTURA');
  await m.screenshot({ path: `${OUT}/fqr-3-factura.png`, fullPage: true });
  // El ticket ya no deja pedir otra.
  await m.goto(`http://localhost:3000/factura/${tk}`);
  await m.waitForSelector('text=ya está hecha');
  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('Factura por QR OK');
})().catch((e) => { console.error(e); process.exit(1); });
