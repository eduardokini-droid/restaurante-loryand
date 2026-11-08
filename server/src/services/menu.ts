import { z } from 'zod';
import type { Tx } from '../db.js';
import { badRequest } from '../errors.js';

export const MENU_SECTIONS = ['first', 'second', 'dessert', 'drink', 'coffee'] as const;
export type MenuSection = (typeof MENU_SECTIONS)[number];
export const SECTION_LABEL: Record<MenuSection, string> = { first: 'Primero', second: 'Segundo', dessert: 'Postre', drink: 'Bebida', coffee: 'Café' };
/** Primeros, segundos y postres van a cocina; bebidas y cafés, a barra. */
export const SECTION_ROUTE: Record<MenuSection, { destination: 'kitchen' | 'bar'; course: number }> = {
  first: { destination: 'kitchen', course: 1 },
  second: { destination: 'kitchen', course: 2 },
  dessert: { destination: 'kitchen', course: 3 },
  drink: { destination: 'bar', course: 1 },
  coffee: { destination: 'bar', course: 3 },
};

const alternatives = z.union([z.string(), z.array(z.string())]).transform((v) => {
  const parts = Array.isArray(v) ? v : v.split(/\n+/);
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
}).pipe(z.array(z.string().max(90, 'cada alternativa admite hasta 90 caracteres')).max(20, 'cada apartado admite hasta 20 alternativas'));

export const menuSchema = z.object({
  name: z.string().min(1).max(80).default('Menú del día'),
  priceCents: z.number().int().positive('el precio debe ser mayor que cero'),
  vatRate: z.union([z.literal(0), z.literal(4), z.literal(10), z.literal(21)]).default(10),
  sections: z.object({
    first: alternatives, second: alternatives,
    dessert: alternatives.default([]), drink: alternatives.default([]), coffee: alternatives.default([]),
  }).refine((s) => s.first.length > 0 && s.second.length > 0, 'añade al menos un primer plato y un segundo'),
  active: z.boolean(),
});

export const menuChoice = z.object({
  first: z.string(), second: z.string(),
  dessert: z.string().nullish(), drink: z.string().nullish(), coffee: z.string().nullish(),
});
export type MenuChoice = z.infer<typeof menuChoice>;

export interface MenuRow { name: string; price_cents: number; vat_rate: string; sections: Record<MenuSection, string[]>; active: boolean }

export async function activeMenu(tx: Tx, establishmentId: string): Promise<MenuRow | undefined> {
  const [m] = await tx<MenuRow[]>`select name, price_cents, vat_rate, sections, active from daily_menus where establishment_id = ${establishmentId} and active`;
  return m;
}

/** Comprueba que se ha elegido una alternativa válida en cada apartado incluido. */
export function validateChoice(menu: MenuRow, choice: MenuChoice): Array<{ section: MenuSection; value: string }> {
  const out: Array<{ section: MenuSection; value: string }> = [];
  for (const s of MENU_SECTIONS) {
    const options = menu.sections[s] ?? [];
    const v = choice[s]?.trim();
    if (options.length === 0) continue;
    if (!v) throw badRequest(`Elige ${SECTION_LABEL[s].toLowerCase()} del menú`);
    if (!options.includes(v)) throw badRequest(`«${v}» no está en el menú de hoy`);
    out.push({ section: s, value: v });
  }
  return out;
}
