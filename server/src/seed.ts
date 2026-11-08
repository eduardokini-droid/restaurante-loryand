/** Datos de demostración para desarrollo. Uso: npm run seed (no borra nada si el local "demo" ya existe). */
import { sql } from './db.js';
import { migrate } from './migrate.js';
import { seedDemo } from './demo.js';

await migrate();
const created = await seedDemo({ createGestor: true, adminPassword: 'admin1234' });
console.log(created ? `Datos de demostración creados.
  Gestor general:  gestor / gestor1234
  Administrador:   admin / admin1234
  Cocina / Barra:  cocina / cocina1234 · barra / barra1234
  Camareros (PDA): local "demo" · camarero-1 PIN 1111 · camarero-2 PIN 2222` : 'El local de demostración ya existe.');
await sql.end();
