import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { MODULES, actorLabel, establishmentOf, hashPassword, pinLookup, requireModule } from '../auth.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { audit } from '../services/audit.js';
import { AppError } from '../errors.js';
import { LANGS, translateTexts, translationAvailable } from '../services/translate.js';

export const ALLERGENS = [
  'gluten', 'crustaceos', 'huevos', 'pescado', 'cacahuetes', 'soja', 'lacteos',
  'frutos_cascara', 'apio', 'mostaza', 'sesamo', 'sulfitos', 'altramuces', 'moluscos',
] as const;

/** Las opciones se escriben una por línea; también se aceptan comas o punto y coma. */
export function splitOptions(v: string | string[]): string[] {
  const parts = Array.isArray(v) ? v : v.split(/[\n;,]+/);
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))].slice(0, 30);
}

/** Foto de producto: una imagen subida al propio servidor o una dirección https. */
const photoUrl = z.string().max(500).refine((v) => /^\/api\/img\/[0-9a-f-]{36}$/.test(v) || /^https:\/\//.test(v), 'La foto debe ser una imagen subida o una dirección https');

const establishmentSchema = z.object({
  name: z.string().min(1).max(120),
  legalName: z.string().max(160),
  taxId: z.string().max(20),
  phone: z.string().max(30),
  email: z.string().max(120),
  address: z.string().max(200),
  postalCode: z.string().max(10),
  city: z.string().max(80),
  province: z.string().max(80),
  businessType: z.enum(['restaurant', 'bar', 'cafe', 'pub', 'bakery', 'icecream', 'other']),
  settings: z.object({
    sharedTables: z.boolean(),
    blockPaymentUntilDelivered: z.boolean(),
    labelTagline: z.string().max(48),
    ticketLogo: z.boolean(),
    ticketInvoiceQr: z.boolean(),
    kdsWarnMin: z.number().int().min(1).max(120),
    kdsLateMin: z.number().int().min(2).max(240),
  }).partial(),
  privacy: z.object({
    contactEmail: z.string().trim().max(120).refine((v) => v === '' || /^\S+@\S+\.\S+$/.test(v), 'Correo no válido'),
    registry: z.string().trim().max(200),
    reservationMonths: z.number().int().min(1).max(60),
    waitlistDays: z.number().int().min(1).max(365),
    messageLogMonths: z.number().int().min(1).max(60),
  }).partial(),
}).partial();

const productSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(600).default(''),
  priceCents: z.number().int().min(0).max(1_000_000),
  vatRate: z.union([z.literal(0), z.literal(4), z.literal(10), z.literal(21)]).default(10),
  destination: z.enum(['kitchen', 'bar']).default('kitchen'),
  course: z.number().int().min(1).max(5).default(1),
  visible: z.boolean().default(true),
  options: z.union([z.string(), z.array(z.string())]).default([]).transform(splitOptions),
  allergens: z.array(z.enum(ALLERGENS)).default([]),
  categoryId: z.string().uuid().nullable().default(null),
  subcategoryId: z.string().uuid().nullable().default(null),
  photoUrl: photoUrl.nullable().default(null),
  translations: z.partialRecord(z.enum(LANGS), z.object({ name: z.string().max(120).default(''), description: z.string().max(600).default('') })).optional(),
});

/** Campos de producto SIN valores por defecto: al editar solo cambia lo que se envía. */
const productEdit = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(600),
  priceCents: z.number().int().min(0).max(1_000_000),
  vatRate: z.union([z.literal(0), z.literal(4), z.literal(10), z.literal(21)]),
  destination: z.enum(['kitchen', 'bar']),
  course: z.number().int().min(1).max(5),
  visible: z.boolean(),
  options: z.union([z.string(), z.array(z.string())]).transform(splitOptions),
  allergens: z.array(z.enum(ALLERGENS)),
  categoryId: z.string().uuid().nullable(),
  subcategoryId: z.string().uuid().nullable(),
  photoUrl: photoUrl.nullable(),
  translations: z.partialRecord(z.enum(LANGS), z.object({ name: z.string().max(120).default(''), description: z.string().max(600).default('') })),
}).partial();

const tableSchema = z.object({
  label: z.string().min(1).max(20),
  zone: z.enum(['salon', 'terraza', 'barra', 'reservado']).default('salon'),
  seats: z.number().int().min(1).max(40).default(4),
  active: z.boolean().default(true),
  joinGroup: z.string().max(20).nullable().optional().transform((v) => (v?.trim() ? v.trim() : null)),
  posX: z.number().int().min(0).max(100).nullable().optional(),
  posY: z.number().int().min(0).max(100).nullable().optional(),
  shape: z.enum(['square', 'round', 'rect']).optional(),
});
/** Campos de mesa SIN valores por defecto, para editar. */
const tableEdit = z.object({
  label: z.string().min(1).max(20),
  zone: z.enum(['salon', 'terraza', 'barra', 'reservado']),
  seats: z.number().int().min(1).max(40),
  active: z.boolean(),
  joinGroup: z.string().max(20).nullable().transform((v) => (v?.trim() ? v.trim() : null)),
  posX: z.number().int().min(0).max(100).nullable(),
  posY: z.number().int().min(0).max(100).nullable(),
  shape: z.enum(['square', 'round', 'rect']),
  regenerateQr: z.literal(true),
}).partial();

const id = z.object({ id: z.string().uuid() });

export default async function adminRoutes(app: FastifyInstance) {
  // ---------- Datos del negocio ----------
  app.get('/api/admin/establishment', async (req) => {
    requireModule(req, 'config');
    const [e] = await sql`select * from establishments where id = ${establishmentOf(req)}`;
    if (!e) throw notFound('Establecimiento');
    return e;
  });

  app.put('/api/admin/establishment', async (req) => {
    const a = requireModule(req, 'config');
    const est = establishmentOf(req);
    const b = parse(establishmentSchema, req.body);
    const cols: Record<string, unknown> = {};
    const map: Record<string, string> = { businessType: 'business_type', name: 'name', legalName: 'legal_name', taxId: 'tax_id', phone: 'phone', email: 'email', address: 'address', postalCode: 'postal_code', city: 'city', province: 'province' };
    for (const [k, c] of Object.entries(map)) if (b[k as keyof typeof b] !== undefined) cols[c] = b[k as keyof typeof b];
    await sql.begin(async (tx) => {
      if (Object.keys(cols).length) await tx`update establishments set ${tx(cols)} where id = ${est}`;
      if (b.settings) await tx`update establishments set settings = settings || ${tx.json(b.settings)} where id = ${est}`;
      if (b.privacy) await tx`update establishments set privacy = privacy || ${tx.json(b.privacy)} where id = ${est}`;
      await audit(tx, est, actorLabel(a), 'establishment.update', b);
    });
    notify(est, ['tables', 'waiters']);
    const [e] = await sql`select * from establishments where id = ${est}`;
    return e;
  });

  // ---------- Usuarios del panel ----------
  app.get('/api/admin/users', async (req) => {
    requireModule(req, 'users');
    return sql`select id, username, name, email, role, permissions, active, totp_enabled, created_at from users
               where establishment_id = ${establishmentOf(req)} order by name`;
  });

  app.post('/api/admin/users', async (req) => {
    const a = requireModule(req, 'users');
    const est = establishmentOf(req);
    const b = parse(z.object({
      name: z.string().min(1).max(80),
      username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i, 'solo letras, números, punto y guion'),
      password: z.string().min(8, 'mínimo 8 caracteres').max(100),
      email: z.string().trim().toLowerCase().email('Correo no válido').max(120).optional(),
      permissions: z.array(z.enum(MODULES)).default([]),
    }), req.body);
    if (a.kind === 'user' && a.role === 'staff' && b.permissions.some((p) => !a.permissions.includes(p))) {
      throw forbidden('No puedes conceder permisos que no tienes');
    }
    const [exists] = await sql`select 1 from users where lower(username) = lower(${b.username})`;
    if (exists) throw conflict('username_taken', 'Ese nombre de usuario ya existe');
    const [u] = await sql`
      insert into users (establishment_id, username, name, password_hash, role, permissions, email)
      values (${est}, ${b.username}, ${b.name}, ${await hashPassword(b.password)}, 'staff', ${b.permissions}, ${b.email ?? null})
      returning id, username, name, email, role, permissions, active`;
    return u;
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const a = requireModule(req, 'users');
    const est = establishmentOf(req);
    const { id: uid } = parse(id, req.params);
    const b = parse(z.object({
      permissions: z.array(z.enum(MODULES)),
      password: z.string().min(8).max(100),
      active: z.boolean(),
      name: z.string().min(1).max(80),
      email: z.string().trim().toLowerCase().email('Correo no válido').max(120).nullable(),
    }).partial(), req.body);
    const [target] = await sql`select id, role from users where id = ${uid} and establishment_id = ${est}`;
    if (!target) throw notFound('Usuario');
    if (target.role !== 'staff' && !(a.kind === 'user' && a.role === 'superadmin')) throw forbidden('Solo el gestor puede modificar al administrador');
    if (a.kind === 'user' && a.role === 'staff' && b.permissions?.some((p) => !a.permissions.includes(p))) throw forbidden('No puedes conceder permisos que no tienes');
    const cols: Record<string, unknown> = {};
    if (b.permissions) cols.permissions = b.permissions;
    if (b.active !== undefined) cols.active = b.active;
    if (b.name) cols.name = b.name;
    if (b.email !== undefined) cols.email = b.email;
    if (b.password) cols.password_hash = await hashPassword(b.password);
    if (Object.keys(cols).length) await sql`update users set ${sql(cols)} where id = ${uid}`;
    // Cambios de permisos o contraseña: se cierran sus sesiones para que se apliquen al volver a entrar.
    if (b.permissions || b.password || b.active === false) await sql`delete from sessions where user_id = ${uid}`;
    return { ok: true };
  });

  // ---------- Camareros ----------
  app.get('/api/admin/waiters', async (req) => {
    requireModule(req, 'waiters');
    const est = establishmentOf(req);
    return sql`
      select w.id, w.code, w.name, w.active, w.qr_token, 'camarero-' || w.code as username, w.staff_role, w.document_id,
             coalesce(array_agg(wt.table_id) filter (where wt.table_id is not null), '{}') as table_ids,
             (select started_at from shifts s where s.waiter_id = w.id and s.ended_at is null and s.status = 'valid') as shift_started_at
      from waiters w left join waiter_tables wt on wt.waiter_id = w.id
      where w.establishment_id = ${est}
      group by w.id order by w.code`;
  });

  const pinSchema = z.string().regex(/^\d{4,6}$/, 'el PIN debe tener de 4 a 6 cifras');

  app.post('/api/admin/waiters', async (req) => {
    const a = requireModule(req, 'waiters');
    const est = establishmentOf(req);
    const b = parse(z.object({ name: z.string().min(1).max(80), pin: pinSchema, staffRole: z.enum(['sala', 'cocina', 'barra', 'otros']).default('sala'), documentId: z.string().max(20).default('') }), req.body);
    const lookup = pinLookup(est, b.pin);
    return sql.begin(async (tx) => {
      await tx`select id from establishments where id = ${est} for update`;
      const [dup] = await tx`select 1 from waiters where establishment_id = ${est} and pin_lookup = ${lookup}`;
      if (dup) throw conflict('pin_taken', 'Ese PIN ya lo usa otro camarero del local');
      const [{ next }] = await tx`select coalesce(max(code), 0) + 1 as next from waiters where establishment_id = ${est}`;
      const [w] = await tx`
        insert into waiters (establishment_id, code, name, pin_hash, pin_lookup, staff_role, document_id)
        values (${est}, ${next}, ${b.name}, ${await hashPassword(b.pin)}, ${lookup}, ${b.staffRole}, ${b.documentId.trim().toUpperCase()})
        returning id, code, name, active, qr_token, 'camarero-' || code as username, staff_role, document_id`;
      await audit(tx, est, actorLabel(a), 'waiter.create', { waiterId: w.id });
      return w;
    });
  });

  app.patch('/api/admin/waiters/:id', async (req) => {
    const a = requireModule(req, 'waiters');
    const est = establishmentOf(req);
    const { id: wid } = parse(id, req.params);
    const b = parse(z.object({
      name: z.string().min(1).max(80), pin: pinSchema, active: z.boolean(),
      tableIds: z.array(z.string().uuid()), regenerateQr: z.literal(true),
      staffRole: z.enum(['sala', 'cocina', 'barra', 'otros']), documentId: z.string().max(20),
    }).partial(), req.body);
    await sql.begin(async (tx) => {
      const [w] = await tx`select id from waiters where id = ${wid} and establishment_id = ${est} for update`;
      if (!w) throw notFound('Camarero');
      if (b.name) await tx`update waiters set name = ${b.name} where id = ${wid}`;
      if (b.active !== undefined) await tx`update waiters set active = ${b.active} where id = ${wid}`;
      if (b.staffRole) await tx`update waiters set staff_role = ${b.staffRole} where id = ${wid}`;
      if (b.documentId !== undefined) await tx`update waiters set document_id = ${b.documentId.trim().toUpperCase()} where id = ${wid}`;
      if (b.pin) {
        const lookup = pinLookup(est, b.pin);
        const [dup] = await tx`select 1 from waiters where establishment_id = ${est} and pin_lookup = ${lookup} and id <> ${wid}`;
        if (dup) throw conflict('pin_taken', 'Ese PIN ya lo usa otro camarero del local');
        await tx`update waiters set pin_hash = ${await hashPassword(b.pin)}, pin_lookup = ${lookup} where id = ${wid}`;
      }
      if (b.regenerateQr) await tx`update waiters set qr_token = encode(gen_random_bytes(18), 'hex') where id = ${wid}`;
      if (b.pin || b.active === false || b.regenerateQr) await tx`delete from sessions where waiter_id = ${wid}`;
      if (b.tableIds) {
        const [{ settings }] = await tx`select settings from establishments where id = ${est}`;
        if (settings.sharedTables) throw conflict('shared_mode', 'Con las mesas compartidas activas no se asignan mesas por camarero');
        const valid = b.tableIds.length
          ? await tx`select id from tables where establishment_id = ${est} and id in ${tx(b.tableIds)}`
          : [];
        // Asignación exclusiva: una mesa asignada a este camarero se retira de los demás.
        await tx`delete from waiter_tables where waiter_id = ${wid}`;
        for (const t of valid) {
          await tx`delete from waiter_tables where table_id = ${t.id}`;
          await tx`insert into waiter_tables (waiter_id, table_id) values (${wid}, ${t.id})`;
        }
      }
      await audit(tx, est, actorLabel(a), 'waiter.update', { waiterId: wid, fields: Object.keys(b) });
    });
    notify(est, ['waiters']);
    return { ok: true };
  });

  // ---------- Categorías ----------
  app.get('/api/admin/categories', async (req) => {
    requireModule(req, 'config');
    return sql`select id, parent_id, name, sort from categories where establishment_id = ${establishmentOf(req)} order by sort, name`;
  });

  app.post('/api/admin/categories', async (req) => {
    requireModule(req, 'config');
    const est = establishmentOf(req);
    const b = parse(z.object({ name: z.string().min(1).max(60), parentId: z.string().uuid().nullable().default(null), sort: z.number().int().default(0) }), req.body);
    if (b.parentId) {
      const [p] = await sql`select parent_id from categories where id = ${b.parentId} and establishment_id = ${est}`;
      if (!p) throw notFound('Categoría');
      if (p.parent_id) throw conflict('too_deep', 'Una subcategoría no puede tener subcategorías');
    }
    const [c] = await sql`insert into categories (establishment_id, parent_id, name, sort) values (${est}, ${b.parentId}, ${b.name}, ${b.sort}) returning *`;
    notify(est, ['products']);
    return c;
  });

  app.patch('/api/admin/categories/:id', async (req) => {
    requireModule(req, 'config');
    const est = establishmentOf(req);
    const { id: cid } = parse(id, req.params);
    const b = parse(z.object({ name: z.string().min(1).max(60), sort: z.number().int(), translations: z.partialRecord(z.enum(LANGS), z.string().max(60)) }).partial(), req.body);
    const cols: Record<string, unknown> = { ...b };
    if (b.translations) cols.translations = sql.json(b.translations);
    const [c] = await sql`update categories set ${sql(cols)} where id = ${cid} and establishment_id = ${est} returning *`;
    if (!c) throw notFound('Categoría');
    notify(est, ['products']);
    return c;
  });

  app.delete('/api/admin/categories/:id', async (req) => {
    requireModule(req, 'config');
    const est = establishmentOf(req);
    const { id: cid } = parse(id, req.params);
    const [{ n }] = await sql`select count(*)::int as n from products where not archived and (category_id = ${cid} or subcategory_id = ${cid})`;
    if (n > 0) throw conflict('category_in_use', `La categoría tiene ${n} producto(s). Muévelos antes de borrarla.`);
    await sql`delete from categories where id = ${cid} and establishment_id = ${est}`;
    notify(est, ['products']);
    return { ok: true };
  });

  // ---------- Productos ----------
  app.get('/api/admin/products', async (req) => {
    requireModule(req, 'config');
    return sql`select * from products where establishment_id = ${establishmentOf(req)} and not archived order by name`;
  });

  async function checkCategories(est: string, categoryId: string | null, subcategoryId: string | null) {
    if (!categoryId && subcategoryId) throw conflict('bad_category', 'Elige primero la categoría');
    if (categoryId) {
      const [c] = await sql`select parent_id from categories where id = ${categoryId} and establishment_id = ${est}`;
      if (!c || c.parent_id) throw conflict('bad_category', 'Categoría no válida');
    }
    if (subcategoryId) {
      const [s] = await sql`select parent_id from categories where id = ${subcategoryId} and establishment_id = ${est}`;
      if (!s || s.parent_id !== categoryId) throw conflict('bad_category', 'La subcategoría no pertenece a la categoría elegida');
    }
  }

  const productCols = (p: z.infer<typeof productEdit>) => {
    const m: Record<string, string> = {
      name: 'name', description: 'description', priceCents: 'price_cents', vatRate: 'vat_rate', destination: 'destination',
      course: 'course', visible: 'visible', options: 'options', allergens: 'allergens', categoryId: 'category_id',
      subcategoryId: 'subcategory_id', photoUrl: 'photo_url', translations: 'translations',
    };
    const out: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(m)) if (p[k as keyof typeof p] !== undefined) out[c] = p[k as keyof typeof p];
    if (out.translations) out.translations = sql.json(out.translations as never);
    return out;
  };

  app.post('/api/admin/products', async (req) => {
    const a = requireModule(req, 'config');
    const est = establishmentOf(req);
    const b = parse(productSchema, req.body);
    await checkCategories(est, b.categoryId, b.subcategoryId);
    const [p] = await sql`insert into products ${sql({ establishment_id: est, ...productCols(b) })} returning *`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'product.create', { productId: p.id, name: p.name }));
    notify(est, ['products']);
    return p;
  });

  app.patch('/api/admin/products/:id', async (req) => {
    const a = requireModule(req, 'config');
    const est = establishmentOf(req);
    const { id: pid } = parse(id, req.params);
    const b = parse(productEdit, req.body);
    const [cur] = await sql`select category_id, subcategory_id, price_cents from products where id = ${pid} and establishment_id = ${est} and not archived`;
    if (!cur) throw notFound('Producto');
    const categoryId = b.categoryId !== undefined ? b.categoryId : cur.category_id;
    const subcategoryId = b.subcategoryId !== undefined ? b.subcategoryId : (b.categoryId !== undefined && b.categoryId !== cur.category_id ? null : cur.subcategory_id);
    await checkCategories(est, categoryId, subcategoryId);
    const cols = { ...productCols(b), category_id: categoryId, subcategory_id: subcategoryId, updated_at: new Date() };
    const [p] = await sql`update products set ${sql(cols)} where id = ${pid} returning *`;
    if (b.priceCents !== undefined && b.priceCents !== cur.price_cents) {
      await sql.begin((tx) => audit(tx, est, actorLabel(a), 'product.price', { productId: pid, from: cur.price_cents, to: b.priceCents }));
    }
    notify(est, ['products']);
    return p;
  });

  app.get('/api/admin/translation-status', async (req) => {
    requireModule(req, 'config');
    return { available: translationAvailable() };
  });

  /** "Traducir automáticamente desde el español": nombre y descripción a los seis idiomas. */
  app.post('/api/admin/products/:id/translate', async (req) => {
    requireModule(req, 'config');
    const est = establishmentOf(req);
    const { id: pid } = parse(id, req.params);
    if (!translationAvailable()) throw new AppError(409, 'translation_unavailable', 'La traducción automática no está configurada (falta la clave de DeepL). Puedes escribir las traducciones a mano.');
    const [p] = await sql`select name, description, translations from products where id = ${pid} and establishment_id = ${est}`;
    if (!p) throw notFound('Producto');
    let t;
    try { t = await translateTexts([p.name, p.description || ' ']); } catch (e) {
      throw new AppError(502, 'translation_failed', `No se pudo traducir: ${(e as Error).message}. El producto sigue guardado; inténtalo de nuevo.`);
    }
    const translations = Object.fromEntries(LANGS.map((l) => [l, { name: t[l][0], description: p.description ? t[l][1] : '' }]));
    const [u] = await sql`update products set translations = ${sql.json(translations)} where id = ${pid} returning *`;
    return u;
  });

  /** Borrar archiva: los pedidos antiguos conservan el nombre y el precio con el que se vendieron. */
  app.delete('/api/admin/products/:id', async (req) => {
    const a = requireModule(req, 'config');
    const est = establishmentOf(req);
    const { id: pid } = parse(id, req.params);
    await sql`update products set archived = true, visible = false where id = ${pid} and establishment_id = ${est}`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'product.archive', { productId: pid }));
    notify(est, ['products']);
    return { ok: true };
  });

  // ---------- Mesas ----------
  app.get('/api/admin/tables', async (req) => {
    requireModule(req, 'tables');
    return sql`select * from tables where establishment_id = ${establishmentOf(req)} order by zone, length(label), label`;
  });

  app.post('/api/admin/tables', async (req) => {
    requireModule(req, 'tables');
    const est = establishmentOf(req);
    const b = parse(tableSchema, req.body);
    const [dup] = await sql`select 1 from tables where establishment_id = ${est} and label = ${b.label}`;
    if (dup) throw conflict('table_exists', `Ya existe la mesa ${b.label}`);
    const { joinGroup, posX, posY, ...rest } = b;
    const [t] = await sql`insert into tables ${sql({ establishment_id: est, ...rest, join_group: joinGroup ?? null })} returning *`;
    notify(est, ['tables']);
    return t;
  });

  app.patch('/api/admin/tables/:id', async (req) => {
    requireModule(req, 'tables');
    const est = establishmentOf(req);
    const { id: tid } = parse(id, req.params);
    const b = parse(tableEdit, req.body);
    const { regenerateQr, joinGroup, posX, posY, ...cols } = b as typeof b & { joinGroup?: string | null };
    if (posX !== undefined) (cols as Record<string, unknown>).pos_x = posX;
    if (posY !== undefined) (cols as Record<string, unknown>).pos_y = posY;
    if ('joinGroup' in (req.body as object)) (cols as Record<string, unknown>).join_group = joinGroup ?? null;
    if (Object.keys(cols).length) {
      const [t] = await sql`update tables set ${sql(cols as Record<string, unknown>)} where id = ${tid} and establishment_id = ${est} returning id`;
      if (!t) throw notFound('Mesa');
    }
    if (regenerateQr) await sql`update tables set qr_token = encode(gen_random_bytes(12), 'hex') where id = ${tid} and establishment_id = ${est}`;
    notify(est, ['tables']);
    const [t] = await sql`select * from tables where id = ${tid}`;
    return t;
  });
}
