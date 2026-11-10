/**
 * Generador ESC/POS (Epson TM-T20II y compatibles: Star en modo ESC/POS, Bixolon, la mayoría de marcas blancas).
 * Texto en la página de códigos PC858 (ESC t 19): incluye ñ, tildes, ¿ ¡ y el símbolo €.
 */
const ESC = 0x1b;
const GS = 0x1d;

const CP858: Record<string, number> = {
  'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'å': 0x86, 'ç': 0x87, 'ê': 0x88, 'ë': 0x89, 'è': 0x8a,
  'ï': 0x8b, 'î': 0x8c, 'ì': 0x8d, 'Ä': 0x8e, 'Å': 0x8f, 'É': 0x90, 'æ': 0x91, 'Æ': 0x92, 'ô': 0x93, 'ö': 0x94, 'ò': 0x95,
  'û': 0x96, 'ù': 0x97, 'ÿ': 0x98, 'Ö': 0x99, 'Ü': 0x9a, 'ø': 0x9b, '£': 0x9c, 'Ø': 0x9d, 'á': 0xa0, 'í': 0xa1, 'ó': 0xa2,
  'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ª': 0xa6, 'º': 0xa7, '¿': 0xa8, '¡': 0xad, 'Á': 0xb5, 'Â': 0xb6, 'À': 0xb7, '©': 0xb8,
  'ã': 0xc6, 'Ã': 0xc7, '€': 0xd5, 'Ê': 0xd2, 'Ë': 0xd3, 'È': 0xd4, 'Í': 0xd6, 'Î': 0xd7, 'Ï': 0xd8, 'Ì': 0xde, 'Ó': 0xe0,
  'ß': 0xe1, 'Ô': 0xe2, 'Ò': 0xe3, 'õ': 0xe4, 'Õ': 0xe5, 'µ': 0xe6, 'Ú': 0xe9, 'Û': 0xea, 'Ù': 0xeb, '·': 0xfa, '°': 0xf8,
};

/** Codifica texto a PC858. Lo que no existe en la página se aproxima (sin tilde) o se sustituye por "?". */
export function encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.replace(/[‘’]/g, "'").replace(/[“”«»]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) out.push(code);
    else if (CP858[ch] !== undefined) out.push(CP858[ch]);
    else if (ch === '\n') out.push(0x0a);
    else {
      const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out.push(plain.length === 1 && plain.charCodeAt(0) < 0x7f ? plain.charCodeAt(0) : 0x3f);
    }
  }
  return out;
}

/** Longitud visible (cada carácter ocupa una columna). */
const len = (s: string) => [...s].length;

export class Ticket {
  private bytes: number[] = [];
  constructor(public width = 48) {
    this.raw(ESC, 0x40);       // inicializar
    this.raw(ESC, 0x74, 19);   // página de códigos PC858 (con €)
  }
  raw(...b: number[]) { this.bytes.push(...b); return this; }
  align(a: 'left' | 'center' | 'right') { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]); }
  bold(on: boolean) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  /** Tamaño: 1 normal, 2 doble alto y ancho. */
  size(n: 1 | 2) { return this.raw(GS, 0x21, n === 2 ? 0x11 : 0x00); }
  text(s: string) { this.bytes.push(...encode(s)); return this; }
  line(s = '') { return this.text(s).raw(0x0a); }
  /** Texto largo partido en líneas del ancho disponible (teniendo en cuenta el tamaño). */
  wrap(s: string, big = false) {
    const w = big ? Math.floor(this.width / 2) : this.width;
    const words = s.split(/\s+/);
    let cur = '';
    for (const word of words) {
      if (len(cur) + len(word) + (cur ? 1 : 0) > w && cur) { this.line(cur); cur = ''; }
      cur = cur ? `${cur} ${word}` : word;
      while (len(cur) > w) { this.line([...cur].slice(0, w).join('')); cur = [...cur].slice(w).join(''); }
    }
    if (cur) this.line(cur);
    return this;
  }
  /** Línea con texto a la izquierda e importe a la derecha. */
  pair(left: string, right: string) {
    const space = this.width - len(right) - 1;
    const l = len(left) > space ? [...left].slice(0, space).join('') : left;
    return this.line(l + ' '.repeat(this.width - len(l) - len(right)) + right);
  }
  rule(ch = '-') { return this.line(ch.repeat(this.width)); }
  feed(n = 1) { return this.raw(ESC, 0x64, n); }
  /** Avance y corte parcial. */
  cut() { return this.feed(3).raw(GS, 0x56, 66, 0); }
  /** Pitido (impresoras de cocina con zumbador; las que no lo tienen lo ignoran). */
  beep() { return this.raw(ESC, 0x42, 2, 2); }
  /** Imagen en blanco y negro (GS v 0): ancho en puntos múltiplo de 8, 1 bit por punto. */
  raster(width: number, height: number, data: Buffer) {
    const bw = width / 8;
    this.raw(GS, 0x76, 0x30, 0, bw & 0xff, bw >> 8, height & 0xff, height >> 8);
    this.bytes.push(...data);
    return this;
  }
  /** Código QR nativo de la impresora (GS ( k, modelo 2), corrección de errores M. */
  qr(text: string, size = 6) {
    const data = Buffer.from(text, 'utf8');
    const n = data.length + 3;
    this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0);           // modelo 2
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, size);              // tamaño del módulo
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31);              // corrección M
    this.raw(GS, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30);  // datos
    this.bytes.push(...data);
    return this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);       // imprimir
  }
  build(): Buffer { return Buffer.from(this.bytes); }
}

const euros = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;
const hhmm = (d: Date | string) => new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
const ddmmyy = (d: Date | string) => new Date(d).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' });

export interface KitchenTicketData {
  station: 'kitchen' | 'bar'; place: string; orderNumber: number; createdAt: Date | string; waiter: string | null;
  note: string; items: Array<{ qty: number; name: string; option: string | null; course: number }>; fire?: number; heldCourses?: number[];
}

/** Comanda para cocina o barra: lo importante, grande y legible a distancia. */
export function kitchenTicket(d: KitchenTicketData, width = 48): Buffer {
  const t = new Ticket(width).beep();
  t.align('center').bold(true).size(2).line(d.station === 'kitchen' ? 'COCINA' : 'BARRA').size(1).bold(false);
  if (d.fire) t.bold(true).size(2).line(`MARCHAR ${d.fire}.º PASE`).size(1).bold(false);
  t.size(2).bold(true).line(d.place).bold(false).size(1);
  t.line(`Pedido ${d.orderNumber} · ${hhmm(d.createdAt)}${d.waiter ? ` · ${d.waiter}` : ''}`);
  t.align('left').rule('=');
  const courses = [...new Set(d.items.map((i) => i.course))].sort();
  for (const c of courses) {
    if (courses.length > 1) t.bold(true).line(`-- ${c}.º pase --`).bold(false);
    for (const i of d.items.filter((x) => x.course === c)) {
      t.size(2).bold(true).wrap(`${i.qty} ${i.name}`, true).bold(false).size(1);
      if (i.option) t.wrap(`   > ${i.option}`);
    }
  }
  if (d.heldCourses?.length) t.rule().line(`En espera: ${d.heldCourses.map((c) => `${c}.º pase`).join(', ')} (se marchará después)`);
  if (d.note) t.rule().bold(true).wrap(`NOTA: ${d.note}`).bold(false);
  return t.rule('=').cut().build();
}

const DOC_TITLE: Record<string, string> = { proforma: 'CUENTA (PROFORMA)', simplified: 'FACTURA SIMPLIFICADA', full: 'FACTURA' };
const METHOD: Record<string, string> = { cash: 'Efectivo', card: 'Tarjeta', bizum: 'Bizum' };

/** Ticket o factura a partir del documento guardado (mismo contenido que la vista previa en pantalla). */
export interface TicketExtras {
  /** Logotipo ya convertido a blanco y negro. */
  logo?: { width: number; height: number; data: Buffer } | null;
  /** Enlace del QR para pedir la factura completa (solo en tickets válidos). */
  invoiceUrl?: string | null;
}

export function documentTicket(doc: { type: string; series: string; number: number; created_at: Date | string; total_cents: number; payload: any }, width = 48, extras: TicketExtras = {}): Buffer {
  const p = doc.payload;
  const t = new Ticket(width).align('center');
  if (extras.logo) t.raster(extras.logo.width, extras.logo.height, extras.logo.data).line();
  t.bold(true).size(2).wrap(p.issuer.name ?? '', true).size(1).bold(false);
  if (p.issuer.legal_name) t.wrap(p.issuer.legal_name);
  if (p.issuer.tax_id) t.line(`NIF ${p.issuer.tax_id}`);
  if (p.issuer.address) t.wrap(`${p.issuer.address} ${p.issuer.postal_code ?? ''} ${p.issuer.city ?? ''}`.trim());
  if (p.issuer.phone) t.line(`Tel. ${p.issuer.phone}`);
  t.align('left').rule();
  t.bold(true).line(`${DOC_TITLE[doc.type] ?? doc.type} ${doc.series}-${String(doc.number).padStart(5, '0')}`).bold(false);
  t.line(`${ddmmyy(doc.created_at)} · ${p.place}`);
  if (p.waiter) t.line(`Atendido por: ${p.waiter}`);
  if (p.customer) {
    t.rule().line(`Cliente: ${p.customer.name}`).line(`NIF ${p.customer.taxId}`);
    t.wrap(`${p.customer.address ?? ''} ${p.customer.postalCode ?? ''} ${p.customer.city ?? ''}`.trim());
  }
  t.rule();
  for (const l of p.lines) {
    if (l.unitCents === 0 && String(l.name).includes('·')) continue; // platos incluidos en un menú
    t.pair(`${l.qty} ${l.name}`, euros(l.unitCents * l.qty));
  }
  for (const d of p.discounts ?? []) t.pair(d.label, `-${euros(d.amountCents)}`);
  if (p.loyaltyCustomer) t.line(`Cliente: ${p.loyaltyCustomer}`);
  t.rule().bold(true).size(2).pair('TOTAL', euros(doc.total_cents).replace(' €', '€')).size(1).bold(false);
  for (const v of p.vat ?? []) t.pair(`IVA ${v.rate}% base ${euros(v.baseCents)}`, euros(v.vatCents));
  if (doc.type === 'proforma') {
    t.rule().align('center').bold(true).wrap('DOCUMENTO INFORMATIVO. NO ES JUSTIFICANTE DE PAGO').bold(false).align('left');
  } else if (p.payments?.length) {
    t.rule();
    for (const x of p.payments) t.pair(METHOD[x.method] ?? x.method, euros(x.amountCents));
  }
  if (extras.invoiceUrl) {
    t.rule().align('center').bold(true).line('¿Necesita factura completa?').bold(false);
    t.line('Escanee el código e indique sus datos').qr(extras.invoiceUrl).line();
  }
  t.rule().align('center').line('Gracias por su visita');
  return t.cut().build();
}

export function testTicket(printerName: string, establishment: string, width = 48): Buffer {
  const t = new Ticket(width).align('center').bold(true).size(2).line('PRUEBA').size(1).bold(false);
  t.line(establishment).line(`Impresora: ${printerName}`).line(ddmmyy(new Date())).align('left').rule();
  t.line('Caracteres: ñ Ñ á é í ó ú ü ¿ ¡ € º ª');
  t.pair('Importe alineado', euros(1234));
  t.line('1234567890'.repeat(Math.ceil(width / 10)).slice(0, width));
  return t.rule().align('center').line('Si lees bien esta línea, la impresora está lista.').cut().build();
}

/** Pulso de apertura del cajón portamonedas (conectado a la impresora de tickets, conector RJ11). */
export function drawerKick(): Buffer {
  return Buffer.from([ESC, 0x40, ESC, 0x70, 0x00, 0x19, 0xfa]);
}

/** Informe de cierre Z en la impresora de tickets. */
export function zReport(est: string, r: any, width = 48): Buffer {
  const t = new Ticket(width).align('center').bold(true).size(2).line(`CIERRE Z ${r.number}`).size(1).bold(false);
  t.line(est).line(`${ddmmyy(r.openedAt)} - ${ddmmyy(r.closedAt)}`).line(`Cerrado por: ${r.closedBy}`).align('left').rule();
  t.bold(true).line('COBROS').bold(false);
  for (const [k, v] of Object.entries(r.byMethod as Record<string, { count: number; cents: number }>)) t.pair(`${METHOD[k] ?? k} (${v.count})`, euros(v.cents));
  t.bold(true).pair('TOTAL COBRADO', euros(r.totalCents)).bold(false).rule();
  t.bold(true).line('EFECTIVO EN CAJA').bold(false);
  t.pair('Fondo inicial', euros(r.openingFloatCents)).pair('Cobros en efectivo', euros(r.byMethod.cash.cents));
  if (r.movementsInCents) t.pair('Entradas', euros(r.movementsInCents));
  if (r.movementsOutCents) t.pair('Salidas', `-${euros(r.movementsOutCents)}`);
  t.pair('Esperado', euros(r.expectedCashCents)).pair('Contado', euros(r.countedCashCents));
  t.bold(true).pair('DESCUADRE', `${r.differenceCents > 0 ? '+' : ''}${euros(r.differenceCents)}`).bold(false).rule();
  t.line(`Tickets: ${r.documents.simplified}${r.documents.first ? ` (${r.documents.first} a ${r.documents.last})` : ''}`);
  t.line(`Facturas completas: ${r.documents.full}`);
  for (const v of r.vat) t.pair(`IVA ${v.rate}% base ${euros(v.baseCents)}`, euros(v.vatCents));
  if (r.discountsCents) t.pair('Descuentos y cupones', euros(r.discountsCents));
  t.line(`Productos anulados: ${r.cancelledItems}`).rule();
  for (const w of r.byWaiter) t.pair(`${w.name} (${w.count})`, euros(w.cents));
  if (r.pendingAccounts.length) { t.rule().bold(true).line('CUENTAS ABIERTAS AL CERRAR').bold(false); for (const p of r.pendingAccounts) t.pair(p.place, euros(p.pendingCents)); }
  if (r.notes) t.rule().wrap(`Notas: ${r.notes}`);
  return t.rule().cut().build();
}
