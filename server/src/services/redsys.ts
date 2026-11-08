import { createCipheriv, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Integración con el TPV virtual Redsys (redirección, firma HMAC_SHA256_V1).
 * 1. Se deriva una clave por pedido cifrando el número de pedido con 3DES (clave del comercio, IV a cero).
 * 2. La firma es HMAC-SHA256 de Ds_MerchantParameters (JSON en Base64) con esa clave.
 */
export const REDSYS_URL = {
  test: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  live: 'https://sis.redsys.es/sis/realizarPago',
} as const;

function orderKey(secretB64: string, order: string): Buffer {
  const key = Buffer.from(secretB64, 'base64');
  if (key.length !== 24) throw new Error('La clave de firma de Redsys no es válida (debe tener 32 caracteres en Base64)');
  const data = Buffer.from(order, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 8) * 8, 0);
  data.copy(padded);
  const c = createCipheriv('des-ede3-cbc', key, Buffer.alloc(8, 0));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]);
}

export function sign(secretB64: string, order: string, merchantParamsB64: string): string {
  return createHmac('sha256', orderKey(secretB64, order)).update(merchantParamsB64).digest('base64');
}

const toUrlSafe = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_');

/** Número de pedido de 12 caracteres: 4 primeros numéricos, como exige Redsys. */
export function newOrderCode(): string {
  const head = String(Date.now() % 10000).padStart(4, '0');
  const tail = Array.from({ length: 8 }, () => '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[randomInt(34)]).join('');
  return head + tail;
}

export interface PaymentRequest {
  merchantCode: string; terminal: string; secret: string; environment: 'test' | 'live';
  order: string; amountCents: number; method: 'card' | 'bizum';
  description: string; merchantName: string; notifyUrl: string; okUrl: string; koUrl: string;
}

export function buildPaymentForm(r: PaymentRequest) {
  const params: Record<string, string> = {
    DS_MERCHANT_AMOUNT: String(r.amountCents),
    DS_MERCHANT_ORDER: r.order,
    DS_MERCHANT_MERCHANTCODE: r.merchantCode,
    DS_MERCHANT_CURRENCY: '978',
    DS_MERCHANT_TRANSACTIONTYPE: '0',
    DS_MERCHANT_TERMINAL: r.terminal,
    DS_MERCHANT_MERCHANTURL: r.notifyUrl,
    DS_MERCHANT_URLOK: r.okUrl,
    DS_MERCHANT_URLKO: r.koUrl,
    DS_MERCHANT_PRODUCTDESCRIPTION: r.description.slice(0, 125),
    DS_MERCHANT_MERCHANTNAME: r.merchantName.slice(0, 25),
    DS_MERCHANT_CONSUMERLANGUAGE: '001',
  };
  // Bizum ('z') o tarjeta ('C').
  params.DS_MERCHANT_PAYMETHODS = r.method === 'bizum' ? 'z' : 'C';
  const merchantParams = Buffer.from(JSON.stringify(params)).toString('base64');
  return {
    url: REDSYS_URL[r.environment],
    fields: { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: merchantParams, Ds_Signature: sign(r.secret, r.order, merchantParams) },
  };
}

export interface Notification { order: string; amountCents: number; response: number; authCode: string; raw: Record<string, string> }

/** Verifica la notificación de Redsys. Devuelve null si la firma no es válida. */
export function parseNotification(secretB64: string, merchantParamsB64: string, signature: string): Notification | null {
  let raw: Record<string, string>;
  try {
    raw = JSON.parse(Buffer.from(merchantParamsB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
  const order = raw.Ds_Order ?? raw.DS_ORDER;
  if (!order) return null;
  const expected = Buffer.from(toUrlSafe(sign(secretB64, order, merchantParamsB64)));
  const given = Buffer.from(toUrlSafe(signature));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return {
    order,
    amountCents: Number(raw.Ds_Amount ?? raw.DS_AMOUNT),
    response: Number(raw.Ds_Response ?? raw.DS_RESPONSE),
    authCode: String(raw.Ds_AuthorisationCode ?? raw.DS_AUTHORISATIONCODE ?? '').trim(),
    raw,
  };
}

/** Respuestas 0000 a 0099: operación autorizada. */
export const isAuthorized = (code: number) => Number.isFinite(code) && code >= 0 && code <= 99;
