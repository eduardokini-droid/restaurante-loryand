// Seguridad del panel: doble verificación (gestor obligado, administrador voluntario), códigos de emergencia
// y enlace de recuperación generado por el administrador. Requiere el servidor con REQUIRE_GESTOR_2FA=true.
// Uso: node e2e/seguridad.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const crypto = require('crypto');
const OUT = process.argv[2];
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (s) => { let bits = 0, v = 0; const o = []; for (const c of s.replace(/\s/g, '')) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const totp = (secret, offset = 0) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset)); const h = crypto.createHmac('sha1', b32(secret)).update(m).digest(); const o = h[19] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0'); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = async (opts = {}) => {
    const p = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1180, height: 860 }, ...opts })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && !/status of 40[13]|status of 410/.test(m.text()) && errors.push(m.text()));
    return p;
  };
  const login = async (p, user, pass) => {
    await p.goto('http://localhost:3000/gestion');
    await p.fill('input[autocomplete=username]', user);
    await p.fill('input[type=password]', pass);
    await p.click('button:has-text("Entrar")');
  };
  const activate = async (p, pass) => {
    await p.fill('input[autocomplete=current-password]', pass);
    await p.click('button:has-text("Activar doble verificación")');
    await p.waitForSelector('img[alt^="Código QR"]');
    const secret = (await p.locator('code').last().textContent()).replace(/\s/g, '');
    await p.fill('input[autocomplete=one-time-code]', totp(secret));
    await p.click('button:has-text("Comprobar y activar")');
    await p.waitForSelector('text=Guarda tus códigos de emergencia');
    const codes = await p.locator('.recovery-codes span').allTextContents();
    if (codes.length !== 10) throw new Error(`Códigos: ${codes.length}`);
    return { secret, codes };
  };

  // 1. Gestor: obligado a activar la doble verificación antes de ver nada.
  const g = await page({ deviceScaleFactor: 2 });
  await login(g, 'gestor', 'gestor1234');
  await g.waitForSelector('text=necesita la doble verificación');
  await g.fill('input[autocomplete=current-password]', 'gestor1234');
  await g.click('button:has-text("Activar doble verificación")');
  await g.waitForSelector('img[alt^="Código QR"]');
  await g.screenshot({ path: `${OUT}/seguridad-1-gestor-qr.png` });
  const gSecret = (await g.locator('code').last().textContent()).replace(/\s/g, '');
  await g.fill('input[autocomplete=one-time-code]', totp(gSecret));
  await g.click('button:has-text("Comprobar y activar")');
  await g.waitForSelector('text=Guarda tus códigos de emergencia');
  await g.screenshot({ path: `${OUT}/seguridad-2-codigos.png` });
  await g.click('button:has-text("Ya los he guardado")');
  await g.waitForSelector('text=Gestor general · Establecimientos');

  // 2. Administrador: activa la suya; al volver a entrar se le pide el código.
  const a = await page();
  await login(a, 'admin', 'admin1234');
  await a.waitForSelector('text=Mesas con cuenta abierta');
  await a.click('nav a:has-text("Mi cuenta")');
  const { secret, codes } = await activate(a, 'admin1234');
  await a.click('button:has-text("Ya los he guardado")');
  await a.waitForSelector('text=Te quedan 10 códigos de emergencia');
  await a.click('button:has-text("Salir / cambiar usuario")');
  await login(a, 'admin', 'admin1234');
  await a.waitForSelector('text=Código de verificación');
  await a.fill('input[autocomplete=one-time-code]', '000000');
  await a.click('button:has-text("Verificar")');
  await a.waitForSelector('text=Código incorrecto');
  await a.fill('input[autocomplete=one-time-code]', totp(secret, 1));
  await a.click('button:has-text("Verificar")');
  await a.waitForSelector('text=Mesas con cuenta abierta');
  // Entrada con código de emergencia.
  await a.click('button:has-text("Salir / cambiar usuario")');
  await login(a, 'admin', 'admin1234');
  await a.click('button:has-text("usar un código de emergencia")');
  await a.fill('input[autocomplete=one-time-code]', codes[3]);
  await a.click('button:has-text("Verificar")');
  await a.waitForSelector('text=Mesas con cuenta abierta');
  await a.click('nav a:has-text("Mi cuenta")');
  await a.waitForSelector('text=Has entrado con un código de emergencia. Te quedan 9');

  // 3. El administrador genera un enlace para la pantalla de cocina; se usa una vez.
  await a.click('nav a:has-text("Usuarios y permisos")');
  await a.click('tr:has(div.small.muted:text-matches("^cocina ·")) button:has-text("Enlace para nueva contraseña")');
  await a.waitForSelector('.modal h2:has-text("cocina")');
  const url = await a.locator('.modal input[readonly]').inputValue();
  await a.screenshot({ path: `${OUT}/seguridad-3-enlace.png` });
  await a.click('.modal button:has-text("Hecho")');
  const k = await page();
  await k.goto(url);
  await k.waitForSelector('text=Elige una contraseña nueva');
  await k.fill('input[autocomplete=new-password] >> nth=0', 'cocina-nueva-1');
  await k.fill('input[autocomplete=new-password] >> nth=1', 'cocina-nueva-1');
  await k.click('button:has-text("Guardar contraseña")');
  await k.waitForSelector('text=Contraseña cambiada');
  await k.goto(url);
  await k.waitForSelector('text=ya se ha usado o ha caducado');
  await login(k, 'cocina', 'cocina-nueva-1');
  await k.waitForSelector('text=Salir / cambiar usuario');
  await k.screenshot({ path: `${OUT}/seguridad-4-cocina.png` });

  // 4. «¿Has olvidado la contraseña?» sin correo configurado: indica a quién pedir el enlace.
  const f = await page();
  await f.goto('http://localhost:3000/gestion');
  await f.click('button:has-text("¿Has olvidado la contraseña?")');
  await f.fill('input[autocomplete=username]', 'barra');
  await f.click('button:has-text("Enviar enlace")');
  await f.waitForSelector('text=Pide al administrador de tu local');

  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('Seguridad OK');
})().catch((e) => { console.error(e); process.exit(1); });
