import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { AppError, conflict, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { checkLimit, recordFailure } from '../ratelimit.js';
import { audit } from '../services/audit.js';
import { convertToFull } from '../services/documents.js';
import { validSpanishTaxId } from '../services/nif.js';
import { mailConfigured, sendMail } from '../services/mail.js';
import { config } from '../config.js';

const token = z.object({ token: z.string().regex(/^[a-f0-9]{24}$/) });
const LOGO = "case when e.logo_image_id is null then null else '/api/img/' || e.logo_image_id end";

/**
 * El cliente pide su factura completa escaneando el QR del ticket: indica sus datos fiscales y la factura
 * sustituye al ticket (misma numeración de facturas completas, mismas líneas e importes). Una sola vez y dentro del trimestre.
 */
export default async function invoiceRequestRoutes(app: FastifyInstance) {
  app.get('/api/public/invoice/:token', async (req) => {
    const { token: tk } = parse(token, req.params);
    const [d] = await sql.unsafe(`
      select d.id, d.type, d.series, d.number, d.total_cents, d.status, d.created_at, d.payload, d.public_token,
             e.name as establishment, e.active, ${LOGO} as logo_url,
             (extract(year from d.created_at at time zone 'Europe/Madrid') = extract(year from now() at time zone 'Europe/Madrid')
              and extract(quarter from d.created_at at time zone 'Europe/Madrid') = extract(quarter from now() at time zone 'Europe/Madrid')) as same_quarter,
             (select f.public_token from documents f where f.replaces_id = d.id and f.type = 'full' limit 1) as full_token
      from documents d join establishments e on e.id = d.establishment_id where d.public_token = $1`, [tk]);
    if (!d || !d.active || d.type === 'proforma') throw notFound('Ticket');
    const canRequest = d.type === 'simplified' && d.status === 'valid' && d.same_quarter;
    return {
      establishment: d.establishment, logoUrl: d.logo_url, type: d.type, code: `${d.series}-${String(d.number).padStart(5, '0')}`,
      createdAt: d.created_at, totalCents: d.total_cents, status: d.status, fullToken: d.full_token,
      canRequest, reason: canRequest ? null : d.type === 'full' ? 'is_full' : d.status === 'replaced' ? 'already' : d.status !== 'valid' ? 'voided' : 'other_quarter',
      // El documento completo solo se muestra si ya es una factura completa (sus datos los puso el propio cliente).
      document: d.type === 'full' ? { type: d.type, series: d.series, number: d.number, total_cents: d.total_cents, created_at: d.created_at, payload: d.payload } : null,
    };
  });

  app.post('/api/public/invoice/:token', async (req) => {
    const { token: tk } = parse(token, req.params);
    checkLimit(req, 'invoice');
    const b = parse(z.object({
      name: z.string().trim().min(2, 'Indica el nombre o la razón social').max(160),
      taxId: z.string().trim().toUpperCase().transform((v) => v.replace(/[\s.-]/g, '')),
      foreign: z.boolean().default(false),
      address: z.string().trim().min(3, 'Indica la dirección').max(200),
      postalCode: z.string().trim().max(10).default(''),
      city: z.string().trim().max(80).default(''),
      email: z.string().trim().max(120).refine((v) => v === '' || /^\S+@\S+\.\S+$/.test(v), 'Correo no válido').default(''),
    }), req.body);
    if (b.foreign ? !/^[A-Z0-9]{5,20}$/.test(b.taxId) : !validSpanishTaxId(b.taxId)) {
      recordFailure(req, 'invoice');
      throw new AppError(400, 'bad_tax_id', b.foreign ? 'Número de identificación fiscal no válido' : 'El NIF, NIE o CIF no es correcto. Revisa la letra o el dígito final.');
    }
    const [d] = await sql`select id, establishment_id from documents where public_token = ${tk}`;
    if (!d) throw notFound('Ticket');
    const out = await sql.begin(async (tx) => {
      await tx`select id from establishments where id = ${d.establishment_id} for update`;
      const { foreign: _f, ...customer } = b;
      const r = await convertToFull(tx, d.establishment_id, d.id, customer);
      if ('error' in r) {
        throw conflict(r.error!, {
          not_found: 'Ticket no encontrado', not_simplified: 'Este documento no es un ticket',
          already_replaced: 'Ya se emitió la factura completa de este ticket', other_quarter: 'La factura completa solo se puede pedir dentro del mismo trimestre de la compra. Pídela en el establecimiento.',
        }[r.error!]);
      }
      await audit(tx, d.establishment_id, 'cliente', 'document.full_by_customer', { from: d.id, to: r.document.id });
      return r.document;
    });
    const url = `${config.publicUrl}/factura/${out.public_token}`;
    if (b.email && mailConfigured()) {
      sendMail(b.email, `Su factura ${out.series}-${String(out.number).padStart(5, '0')}`,
        `Hola:\n\nAquí tiene su factura completa: ${url}\n\nDesde ese enlace puede verla, imprimirla o guardarla en PDF.\n`).catch((e) => req.log.error(e));
    }
    return { token: out.public_token, code: `${out.series}-${String(out.number).padStart(5, '0')}` };
  });
}
