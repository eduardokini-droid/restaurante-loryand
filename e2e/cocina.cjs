// Pantalla de cocina por columnas: en espera, nuevos, preparando, listos y entregados, con colores por tiempo.
// Uso: node e2e/cocina.cjs <carpeta-para-capturas>
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const OUT = process.argv[2];
const DB = process.env.DATABASE_URL ?? 'postgres://loryand:loryand@localhost:5432/loryand';
const psql = (q) => execFileSync('psql', [DB, '-qtAc', q]).toString().trim();

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  // Camarero: dos mesas; una con segundo pase retenido.
  const w = await (await browser.newContext({ locale: 'es-ES' })).newPage();
  await w.goto('http://localhost:3000/personal');
  const login = await w.evaluate(() => fetch('/api/auth/waiter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ establishment: 'demo', username: 'camarero-1', pin: '1111', clockIn: true }) }).then((r) => r.status));
  if (login !== 200) throw new Error(`login camarero ${login}`);
  const order = (label, items) => w.evaluate(async ([label, items]) => {
    const floor = await fetch('/api/service/floor').then((r) => r.json());
    const menu = await fetch('/api/service/menu').then((r) => r.json());
    const t = floor.tables.find((x) => x.label === label);
    const it = items.map(([name, qty, option]) => ({ productId: menu.products.find((p) => p.name === name).id, qty, option }));
    return fetch('/api/service/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), target: { tableId: t.id }, items: it }) }).then((r) => r.json());
  }, [label, items]);
  const o1 = await order('3', [['Croquetas caseras', 2], ['Entrecot a la brasa', 1, 'Al punto']]);
  const o2 = await order('T1', [['Patatas bravas', 1], ['Ensalada de temporada', 1]]);
  if (!o1.number) throw new Error('No se creó el pedido');
  // La mesa T1 lleva 25 minutos esperando: debe verse en rojo.
  psql(`update order_items set sent_at = now() - interval '25 minutes' where name in ('Patatas bravas', 'Ensalada de temporada')`);

  const k = await (await browser.newContext({ locale: 'es-ES', viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })).newPage();
  k.on('pageerror', (e) => errors.push(e.message));
  k.on('console', (m) => m.type() === 'error' && !/status of 401/.test(m.text()) && errors.push(m.text()));
  await k.goto('http://localhost:3000/gestion');
  await k.fill('input[autocomplete=username]', 'cocina');
  await k.fill('input[type=password]', 'cocina1234');
  await k.click('button:has-text("Entrar")');
  await k.waitForSelector('text=Pantalla de cocina');
  const col = (name) => k.locator(`section[aria-label="${name}"]`);
  const P1 = `Pedido ${o1.number} ·`;
  const P2 = `Pedido ${o2.number} ·`;
  const card = (column, extra = '') => col(column).locator(`.kds-card:has-text("${P1}")${extra}`);
  await card('En espera').waitFor();
  await col('Nuevos').locator(`.kds-card.late:has-text("${P2}")`).waitFor();
  await card('Nuevos', '.ok').waitFor();
  // Mesa 3: empezar y listo; la mesa T1: solo las bravas, plato a plato.
  await card('Nuevos').locator('button:has-text("Empezar")').click();
  await card('Preparando').waitFor();
  await col('Nuevos').locator(`.kds-card:has-text("${P2}") .kds-item:has-text("Patatas bravas")`).click();
  await col('Preparando').locator(`.kds-card:has-text("${P2}"):has-text("Patatas bravas")`).waitFor();
  await card('Preparando').locator('button:has-text("Listo")').click();
  await card('Listos').waitFor();
  await k.screenshot({ path: `${OUT}/cocina-1-tablero.png` });
  await card('Listos').locator('button:has-text("Entregado")').click();
  await card('Entregados').waitFor();
  // El camarero marcha el segundo pase: el entrecot pasa a Nuevos.
  await w.evaluate((id) => fetch(`/api/service/accounts/${id}/fire`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), o1.accountId);
  await card('Nuevos', ':has-text("Entrecot")').waitFor({ timeout: 15000 });
  await k.screenshot({ path: `${OUT}/cocina-2-marchado.png` });
  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('Cocina OK');
})().catch((e) => { console.error(e); process.exit(1); });
