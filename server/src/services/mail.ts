/**
 * Envío de correos (recuperación de contraseña) con Resend (https://resend.com), por su API HTTP.
 * Variables: MAIL_RESEND_API_KEY y MAIL_FROM (p. ej. "Loryand <no-responder@tudominio.es>").
 * Sin ellas, la recuperación se hace con un enlace que genera el administrador o el gestor.
 */
let fetchImpl: typeof fetch = (...a) => fetch(...a);
export const setMailFetch = (f: typeof fetch) => { fetchImpl = f; };

export const mailConfigured = () => !!(process.env.MAIL_RESEND_API_KEY && process.env.MAIL_FROM);

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!mailConfigured()) throw new Error('Correo no configurado');
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.MAIL_RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`Resend respondió ${res.status}`);
}
