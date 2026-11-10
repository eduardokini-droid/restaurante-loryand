// Logotipo, foto de producto y venta rápida en mostrador con cambio y ticket.
// Uso: node e2e/venta-rapida.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2];

/** PNG de prueba: un círculo de color sobre fondo transparente. */
function png(size, [r, g, b]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const inside = (x - size / 2) ** 2 + (y - size / 2) ** 2 < (size * 0.45) ** 2;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = inside ? 255 : 0;
    }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const logoFile = path.join(OUT, 'logo-prueba.png'); fs.writeFileSync(logoFile, png(600, [196, 98, 58]));
  const photoFile = path.join(OUT, 'foto-prueba.png'); fs.writeFileSync(photoFile, png(1200, [120, 80, 40]));
  const browser = await chromium.launch();
  const errors = [];
  const p = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/status of 40[134]/.test(m.text()) && errors.push(m.text()));
  await p.goto('http://localhost:3000/gestion');
  await p.fill('input[autocomplete=username]', 'admin');
  await p.fill('input[type=password]', 'admin1234');
  await p.click('button:has-text("Entrar")');
  await p.waitForSelector('text=Mesas con cuenta abierta');

  // 1. Logotipo y tipo de negocio.
  await p.click('nav a:has-text("Datos del negocio")');
  await p.setInputFiles('label:has-text("Subir logotipo") input[type=file]', logoFile);
  await p.waitForSelector('text=Logotipo guardado');
  await p.waitForSelector('nav .brand img');
  await p.selectOption('label:has-text("Tipo de negocio") select', 'cafe');
  await p.click('button:has-text("Guardar datos del establecimiento")');
  await p.waitForSelector('text=Datos del establecimiento guardados');

  // 2. Foto de producto.
  await p.click('nav a:has-text("Configuración y carta")');
  await p.click('tr:has-text("Café")');
  await p.setInputFiles('.modal label:has-text("Subir foto") input[type=file]', photoFile);
  await p.waitForSelector('.modal img[src^="/api/img/"]');
  await p.click('.modal button:has-text("Guardar cambios")');
  await p.waitForSelector('.modal', { state: 'detached' });

  // 3. Venta rápida: café (con opción) y croquetas, en efectivo con 20 €.
  await p.click('nav a:has-text("TPV")');
  await p.click('button:has-text("Venta rápida")');
  await p.click('.chip:has-text("Todo"), .chip:has-text("Bebidas")').catch(() => {});
  await p.fill('input[placeholder="Buscar producto…"]', 'café');
  await p.waitForSelector('.product-btn.with-photo:has-text("Café") img');
  await p.click('.product-btn:has-text("Café")');
  await p.click('.modal .product-btn:has-text("Con leche")');
  await p.fill('input[placeholder="Buscar producto…"]', 'croq');
  await p.click('.product-btn:has-text("Croquetas")');
  await p.fill('input[placeholder="Buscar producto…"]', '');
  await p.click('.chip:has-text("20 €")');
  await p.waitForSelector('text=Cambio');
  await p.screenshot({ path: `${OUT}/vr-1-tpv.png` });
  await p.click('button:has-text("Cobrar 11,00")');
  await p.waitForSelector('text=Cobrado 11,00');
  await p.waitForSelector('text=Cambio: 9,00');
  await p.screenshot({ path: `${OUT}/vr-2-cobrado.png` });
  await p.click('button:has-text("Ver ticket")');
  await p.waitForSelector('.modal >> text=Croquetas caseras');
  await p.keyboard.press('Escape').catch(() => {});

  // 4. Cocina recibe las croquetas; la venta no queda abierta en la sala.
  const kds = await p.evaluate(() => fetch('/api/kds/kitchen').then((r) => r.json()));
  if (!JSON.stringify(kds).includes('Croquetas')) throw new Error('Cocina no ha recibido la venta rápida');
  const floor = await p.evaluate(() => fetch('/api/service/floor').then((r) => r.json()));
  if (floor.bar.some((b) => /Venta rápida/.test(b.bar_name))) throw new Error('La venta rápida ha quedado abierta');

  // 5. Logotipo en la carta del cliente.
  const tables = await p.evaluate(() => fetch('/api/admin/tables').then((r) => r.json()));
  const m = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  await m.goto(`http://localhost:3000/carta/${tables[0].qr_token}`);
  await m.waitForSelector('.hero-logo');
  await m.screenshot({ path: `${OUT}/vr-3-carta.png` });

  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('Venta rápida OK');
})().catch((e) => { console.error(e); process.exit(1); });
