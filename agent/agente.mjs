#!/usr/bin/env node
/**
 * Agente de impresión de Restaurante Loryand.
 * Se deja en marcha en un ordenador del local: recoge las comandas y tickets del servidor
 * y los envía a las impresoras (red, USB en Linux, impresora compartida de Windows o CUPS en Mac/Linux).
 * Requiere Node.js 18 o superior. No necesita instalar nada más.
 */
import { createConnection } from 'node:net';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const VERSION = '1.0.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, 'config.json');
const log = (...a) => console.log(new Date().toLocaleTimeString('es-ES'), ...a);

async function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG)) cfg = JSON.parse(await readFile(CONFIG, 'utf8'));
  cfg.server = process.env.LORYAND_SERVER ?? cfg.server;
  cfg.token = process.env.LORYAND_TOKEN ?? cfg.token;
  if (!cfg.server || !cfg.token) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('Configuración inicial del agente de impresión (se guarda en config.json).');
    cfg.server = (await rl.question('Dirección del programa (p. ej. https://restaurante-loryand.onrender.com): ')).trim().replace(/\/$/, '');
    cfg.token = (await rl.question('Token del agente (Gestión → Impresoras → Nuevo agente): ')).trim();
    rl.close();
    await writeFile(CONFIG, JSON.stringify({ server: cfg.server, token: cfg.token }, null, 2));
  }
  return cfg;
}

/** Envía los bytes a la impresora según el tipo de conexión. */
async function sendToPrinter(printer, data) {
  switch (printer.connection) {
    case 'tcp': {
      const [host, port = '9100'] = printer.address.split(':');
      await new Promise((resolve, reject) => {
        const s = createConnection({ host, port: Number(port) });
        const t = setTimeout(() => { s.destroy(); reject(new Error(`La impresora ${printer.address} no responde`)); }, 10000);
        s.on('connect', () => s.end(data));
        s.on('close', (hadError) => { clearTimeout(t); if (!hadError) resolve(); });
        s.on('error', (e) => { clearTimeout(t); reject(new Error(`No se puede conectar con ${printer.address}: ${e.code ?? e.message}`)); });
      });
      return;
    }
    case 'device':
      await writeFile(printer.address, data);
      return;
    case 'windows': {
      if (platform() !== 'win32') throw new Error('La conexión "Windows" solo funciona en un ordenador con Windows');
      const target = printer.address.startsWith('\\\\') ? printer.address : `\\\\localhost\\${printer.address}`;
      const file = join(tmpdir(), `loryand-${Date.now()}.bin`);
      await writeFile(file, data);
      try { await run('cmd', ['/c', 'copy', '/b', file, target]); } finally { await unlink(file).catch(() => {}); }
      return;
    }
    case 'cups': {
      const file = join(tmpdir(), `loryand-${Date.now()}.bin`);
      await writeFile(file, data);
      try { await run('lp', ['-d', printer.address, '-o', 'raw', file]); } finally { await unlink(file).catch(() => {}); }
      return;
    }
    default:
      throw new Error(`Tipo de conexión desconocido: ${printer.connection}`);
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error((stderr || stdout || err.message).toString().trim())) : resolve())));
}

async function main() {
  const cfg = await loadConfig();
  const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' };
  log(`Agente de impresión ${VERSION} conectado a ${cfg.server}. Deja esta ventana abierta.`);
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${cfg.server}/api/agent/poll`, { method: 'POST', headers, body: JSON.stringify({ version: VERSION }) });
      if (res.status === 401) { log('El token no es válido o el agente se ha eliminado. Borra config.json y vuelve a configurarlo.'); process.exit(1); }
      if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
      if (failures) log('Conexión recuperada.');
      failures = 0;
      const { jobs } = await res.json();
      for (const job of jobs) {
        let ok = true; let error;
        try { await sendToPrinter(job.printer, Buffer.from(job.data, 'base64')); log(`Impreso: ${job.title} → ${job.printer.name}`); }
        catch (e) { ok = false; error = e.message; log(`ERROR en ${job.printer.name}: ${error}`); }
        await fetch(`${cfg.server}/api/agent/jobs/${job.id}/result`, { method: 'POST', headers, body: JSON.stringify({ ok, error }) }).catch(() => {});
      }
    } catch (e) {
      failures++;
      if (failures === 1 || failures % 30 === 0) log(`Sin conexión con el servidor (${e.message}). Reintentando… Los trabajos esperan en cola.`);
    }
    await new Promise((r) => setTimeout(r, failures ? Math.min(2000 * failures, 15000) : 2000));
  }
}

main();
