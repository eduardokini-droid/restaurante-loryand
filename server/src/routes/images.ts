import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { actorLabel, establishmentOf, requireActor, requireModule } from '../auth.js';
import { badRequest, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { audit } from '../services/audit.js';

const MAX_BYTES = { logo: 300_000, product: 450_000 } as const;
const SIGNATURES: [string, (b: Buffer) => boolean][] = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];

/** Logotipo del local y fotos de productos. La web las reduce antes de subirlas; aquí se comprueba el formato real. */
export default async function imageRoutes(app: FastifyInstance) {
  app.post('/api/admin/images', async (req) => {
    const a = requireModule(req, 'config');
    const est = establishmentOf(req);
    const b = parse(z.object({ kind: z.enum(['logo', 'product']), dataUrl: z.string().max(800_000) }), req.body);
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl);
    if (!m) throw badRequest('La imagen debe ser PNG, JPG o WebP');
    const data = Buffer.from(m[2], 'base64');
    const real = SIGNATURES.find(([, test]) => test(data))?.[0];
    if (!real) throw badRequest('El archivo no es una imagen válida');
    if (data.length > MAX_BYTES[b.kind]) throw badRequest(`La imagen pesa demasiado (máximo ${Math.round(MAX_BYTES[b.kind] / 1000)} KB)`);
    const [img] = await sql`insert into images (establishment_id, kind, mime, bytes, data) values (${est}, ${b.kind}, ${real}, ${data.length}, ${data}) returning id`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'image.upload', { id: img.id, kind: b.kind, bytes: data.length }));
    return { id: img.id, url: `/api/img/${img.id}` };
  });

  /** Las imágenes no cambian nunca (una nueva tiene otro identificador): se pueden guardar en caché un año. */
  app.get('/api/img/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [img] = await sql`select mime, data from images where id = ${id}`;
    if (!img) throw notFound('Imagen');
    reply.header('content-type', img.mime).header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff');
    return reply.send(img.data);
  });

  /** Logotipo: lo pone el gestor o el administrador con permiso de configuración. */
  app.put('/api/admin/logo', async (req) => {
    const a = requireActor(req);
    requireModule(req, 'config');
    const est = establishmentOf(req);
    const { imageId, print } = parse(z.object({
      imageId: z.string().uuid().nullable(),
      /** Versión en blanco y negro para la impresora de tickets, preparada en el navegador. */
      print: z.object({ width: z.number().int().min(8).max(576).refine((w) => w % 8 === 0), height: z.number().int().min(1).max(400), data: z.string().max(40_000) }).nullish(),
    }), req.body);
    let printData: Buffer | null = null;
    if (imageId && print) {
      printData = Buffer.from(print.data, 'base64');
      if (printData.length !== (print.width / 8) * print.height) throw badRequest('La versión para impresora no tiene el tamaño indicado');
    }
    if (imageId) {
      const [img] = await sql`select 1 from images where id = ${imageId} and establishment_id = ${est} and kind = 'logo'`;
      if (!img) throw notFound('Imagen');
    }
    await sql.begin(async (tx) => {
      await tx`update establishments set logo_image_id = ${imageId}, logo_print = ${printData},
               logo_print_width = ${printData ? print!.width : null}, logo_print_height = ${printData ? print!.height : null} where id = ${est}`;
      await audit(tx, est, actorLabel(a), 'establishment.logo', { imageId });
    });
    return { ok: true, logoUrl: imageId ? `/api/img/${imageId}` : null };
  });
}
