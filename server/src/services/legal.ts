import { sql, type Tx } from '../db.js';

type Q = typeof sql | Tx;

/**
 * Textos de protección de datos (RGPD y LOPDGDD), aviso legal (LSSI) y cookies, generados con los datos de cada local.
 * Son modelos orientativos: cada local debe revisarlos con su asesor. Al cambiar los textos, sube LEGAL_VERSION:
 * los consentimientos guardan la versión con la que se dieron.
 */
export const LEGAL_VERSION = '2026-11-v1';

export interface PrivacySettings {
  /** Correo para ejercer los derechos (si no, el correo general del local). */
  contactEmail: string;
  /** Datos del Registro Mercantil para sociedades (aviso legal). */
  registry: string;
  /** Meses tras la fecha de la reserva antes de anonimizarla. */
  reservationMonths: number;
  /** Días tras cerrar la lista de espera antes de borrar nombre y teléfono. */
  waitlistDays: number;
  /** Meses que se guarda el registro de avisos enviados por WhatsApp. */
  messageLogMonths: number;
}
export const DEFAULT_PRIVACY: PrivacySettings = { contactEmail: '', registry: '', reservationMonths: 12, waitlistDays: 30, messageLogMonths: 12 };
export const privacyOf = (raw: unknown): PrivacySettings => ({ ...DEFAULT_PRIVACY, ...(raw as Partial<PrivacySettings> ?? {}) });

export interface Section { title: string; paragraphs: string[] }
export interface LegalTexts {
  version: string;
  incomplete: string[];
  owner: { name: string; legalName: string; taxId: string; address: string; email: string; phone: string };
  privacy: Section[];
  legalNotice: Section[];
  cookies: Section[];
  /** «Primera capa»: el resumen que se muestra junto a cada formulario. */
  layers: Record<'reservation' | 'waitlist' | 'loyalty' | 'whatsapp' | 'menu', string>;
}

export async function legalTexts(q: Q, establishmentId: string): Promise<LegalTexts> {
  const [e] = await q`select name, legal_name, tax_id, address, postal_code, city, province, email, phone, privacy from establishments where id = ${establishmentId}`;
  const p = privacyOf(e.privacy);
  const legalName = e.legal_name?.trim() || e.name;
  const address = [e.address, [e.postal_code, e.city].filter(Boolean).join(' '), e.province].map((x: string) => x?.trim()).filter(Boolean).join(', ');
  const email = p.contactEmail.trim() || e.email?.trim() || '';
  const incomplete: string[] = [];
  if (!e.legal_name?.trim()) incomplete.push('Razón social o nombre del titular');
  if (!e.tax_id?.trim()) incomplete.push('NIF / CIF');
  if (!e.address?.trim() || !e.city?.trim()) incomplete.push('Dirección completa');
  if (!email) incomplete.push('Correo de contacto');
  const who = `${legalName}${e.tax_id ? ` (NIF ${e.tax_id})` : ''}`;
  const contact = email ? `escribiendo a ${email}` : 'dirigiéndote al establecimiento';
  const contactFull = [email && `escribiendo a ${email}`, address && `por correo postal a ${address}`, 'o en el propio establecimiento'].filter(Boolean).join(', ');
  const rights = `Puedes ejercer tus derechos de acceso, rectificación, supresión, oposición, limitación del tratamiento y portabilidad, y retirar tu consentimiento cuando quieras, ${contact}.`;
  const firstLayerEnd = `${rights} Más información en la política de privacidad.`;

  const privacy: Section[] = [
    { title: '1. Responsable del tratamiento', paragraphs: [
      `${who}, que gestiona el establecimiento «${e.name}».`,
      [address && `Dirección: ${address}.`, email && `Correo: ${email}.`, e.phone && `Teléfono: ${e.phone}.`].filter(Boolean).join(' ') || 'Datos de contacto: los del establecimiento.',
    ] },
    { title: '2. Qué datos tratamos, para qué y durante cuánto tiempo', paragraphs: [
      `Reservas. Nombre, teléfono, correo (opcional), número de personas, fecha, hora y las observaciones que nos indiques. Los usamos para gestionar tu reserva y avisarte de cambios. Base legal: la aplicación de medidas precontractuales a petición tuya y la prestación del servicio (art. 6.1.b RGPD). Se conservan hasta ${p.reservationMonths} meses después de la fecha de la reserva para atender incidencias; después se anonimizan.`,
      'Alergias e intolerancias. Si nos indicas alguna en las observaciones o al personal, la tratamos solo para preparar tu servicio con seguridad y con tu consentimiento explícito (art. 9.2.a RGPD). No es obligatorio facilitarla. Se conserva lo mismo que la reserva o la ficha de cliente en la que la anotes.',
      `Lista de espera. Nombre, teléfono y número de personas, para avisarte cuando tu mesa esté lista. Base legal: tu solicitud (art. 6.1.b RGPD). Se borran ${p.waitlistDays} días después de cerrarse la espera.`,
      `Avisos por WhatsApp. Si lo aceptas, usamos tu teléfono para enviarte la confirmación y el recordatorio de la reserva o el aviso de mesa lista por WhatsApp. Base legal: tu consentimiento (art. 6.1.a RGPD), que puedes retirar cuando quieras sin que afecte a tu reserva: en ese caso te avisaremos por teléfono. Guardamos un registro de los avisos enviados durante ${p.messageLogMonths} meses.`,
      'Programa de fidelización. Nombre, teléfono, correo (opcional), las preferencias que nos indiques, los puntos, los cupones y las consumiciones asociadas a tu tarjeta. Los usamos para gestionar el programa: acumular y canjear puntos y ofrecerte cupones. Base legal: tu consentimiento al darte de alta (art. 6.1.a RGPD) y las condiciones del programa (art. 6.1.b RGPD). Se conservan mientras sigas en el programa; puedes darte de baja en cualquier momento desde tu tarjeta digital o en el establecimiento, y tus datos se suprimen.',
      'Comunicaciones comerciales. Solo si lo aceptas expresamente con la casilla correspondiente te enviaremos ofertas del establecimiento (art. 6.1.a RGPD y art. 21 de la Ley 34/2002, LSSI). Puedes darte de baja en cualquier momento.',
      'Cobros con tarjeta o Bizum en línea. El pago se hace en la pasarela segura del banco (Redsys): nosotros no vemos ni guardamos los datos de tu tarjeta. Solo conservamos el importe, la fecha y el resultado de la operación. Base legal: la prestación del servicio (art. 6.1.b RGPD) y las obligaciones contables y fiscales (art. 6.1.c RGPD).',
      'Facturas. Si pides factura completa, tratamos los datos fiscales que nos facilites para emitirla. Base legal: obligación legal (art. 6.1.c RGPD). Se conservan durante los plazos que exige la normativa fiscal y mercantil (en general, entre 4 y 6 años).',
      'Carta digital y pedidos desde la mesa. No te pedimos datos personales para ver la carta ni para pedir. Tu navegador guarda el idioma elegido y el pedido en curso solo para que la carta funcione (ver la política de cookies).',
    ] },
    { title: '3. A quién se comunican tus datos', paragraphs: [
      'No vendemos ni cedemos tus datos a terceros. Pueden acceder a ellos, solo para prestarnos el servicio y con contrato de encargado del tratamiento (art. 28 RGPD), los proveedores del programa de gestión del restaurante y de su alojamiento y copias de seguridad en la nube, y la entidad bancaria y la pasarela de pago (Redsys) en los cobros en línea.',
      'Si aceptas los avisos por WhatsApp, el mensaje se envía a través de WhatsApp, servicio de WhatsApp Ireland Ltd. (grupo Meta). Meta puede tratar datos en Estados Unidos; esa transferencia se ampara en el Marco de Privacidad de Datos UE-EE. UU. (decisión de adecuación de la Comisión Europea de 10 de julio de 2023) y en las cláusulas contractuales tipo.',
      'También podemos comunicar datos a las administraciones públicas y a jueces y tribunales cuando una ley nos obligue.',
    ] },
    { title: '4. Tus derechos', paragraphs: [
      `${rights.replace(contact, contactFull)} Indica qué derecho quieres ejercer y, si no te podemos identificar por el teléfono o correo que usaste con nosotros, acompaña una forma de identificarte.`,
      'Respondemos en el plazo de un mes. Si consideras que no hemos atendido bien tu solicitud, puedes reclamar ante la Agencia Española de Protección de Datos (www.aepd.es, C/ Jorge Juan 6, 28001 Madrid).',
    ] },
    { title: '5. Menores', paragraphs: ['Las reservas, la lista de espera y el programa de fidelización están dirigidos a mayores de 14 años (art. 7 de la Ley Orgánica 3/2018). Los menores de esa edad necesitan que lo hagan sus padres o tutores.'] },
    { title: '6. Seguridad', paragraphs: ['Aplicamos medidas técnicas y organizativas adecuadas: acceso al programa con usuario y contraseña personales, permisos según el puesto, conexión cifrada, registro de actividad y copias de seguridad cifradas.'] },
    { title: '7. Cambios', paragraphs: [`Versión ${LEGAL_VERSION}. Si cambiamos esta política, publicaremos aquí la nueva versión.`] },
  ];

  const legalNotice: Section[] = [
    { title: 'Titular', paragraphs: [
      `En cumplimiento del artículo 10 de la Ley 34/2002, de servicios de la sociedad de la información y de comercio electrónico (LSSI), se informa de que las páginas de carta digital, reservas, tarjeta de cliente y pago de «${e.name}» son titularidad de ${who}.`,
      [address && `Domicilio: ${address}.`, email && `Correo: ${email}.`, e.phone && `Teléfono: ${e.phone}.`, p.registry.trim() && `${p.registry.trim()}.`].filter(Boolean).join(' '),
    ].filter(Boolean) },
    { title: 'Uso', paragraphs: [
      'Estas páginas sirven para consultar la carta, pedir desde la mesa, solicitar reservas, consultar la tarjeta de cliente y pagar la cuenta. Quien las usa se compromete a hacerlo de buena fe y a no introducir datos de otras personas sin su autorización.',
      'Los precios de la carta incluyen el IVA. La información sobre alérgenos se ofrece conforme al Reglamento (UE) 1169/2011; ante cualquier duda, consulta al personal antes de pedir.',
    ] },
    { title: 'Propiedad intelectual', paragraphs: [`Los textos, fotografías y marcas de «${e.name}» pertenecen a su titular o se usan con autorización. No se permite reproducirlos con fines comerciales sin permiso.`] },
    { title: 'Responsabilidad y ley aplicable', paragraphs: ['El titular procura que la información sea correcta y esté actualizada, pero no responde de interrupciones del servicio por causas técnicas ajenas. Estas condiciones se rigen por la ley española.'] },
  ];

  const cookies: Section[] = [
    { title: 'Qué usamos', paragraphs: [
      'Estas páginas no usan cookies de publicidad, de análisis ni de terceros con fines de seguimiento.',
      'Solo se guarda en tu navegador lo imprescindible para que funcionen: el idioma de la carta, el pedido en curso y, en el caso del personal del establecimiento, la cookie de sesión para mantener el acceso. Son cookies y almacenamiento técnicos, exentos de consentimiento según el artículo 22.2 de la LSSI, y puedes borrarlos desde la configuración de tu navegador.',
      'Al pagar en línea pasas a la página segura del banco (Redsys), que tiene su propia política de cookies.',
    ] },
  ];

  const layers = {
    reservation: `Responsable: ${who}. Finalidad: gestionar tu reserva. Legitimación: tu solicitud. Destinatarios: proveedores tecnológicos con contrato; no se ceden a terceros. Conservación: hasta ${p.reservationMonths} meses tras la reserva. ${firstLayerEnd}`,
    waitlist: `Responsable: ${who}. Usamos tu nombre y teléfono solo para avisarte cuando tu mesa esté lista y los borramos a los ${p.waitlistDays} días. ${firstLayerEnd}`,
    loyalty: `Responsable: ${who}. Finalidad: gestionar el programa de fidelización (puntos, cupones y preferencias) y, solo si lo aceptas, enviarte ofertas. Legitimación: tu consentimiento. Conservación: mientras sigas en el programa; puedes darte de baja desde tu tarjeta digital. ${firstLayerEnd}`,
    whatsapp: 'Los avisos se envían por WhatsApp (WhatsApp Ireland Ltd., grupo Meta, que puede tratar datos en EE. UU. con garantías adecuadas). Es voluntario: si no lo aceptas, te avisamos por teléfono.',
    menu: `Para ver la carta y pedir no necesitas dar datos personales. Titular: ${who}.`,
  };

  return {
    version: LEGAL_VERSION, incomplete,
    owner: { name: e.name, legalName, taxId: e.tax_id ?? '', address, email, phone: e.phone ?? '' },
    privacy, legalNotice, cookies, layers,
  };
}

/** Guarda la prueba de un consentimiento (o de su retirada). */
export async function logConsent(q: Q, c: {
  establishmentId: string; kind: 'reservation' | 'waitlist' | 'customer'; subjectId: string;
  purpose: 'privacy' | 'whatsapp' | 'marketing'; granted: boolean; source: 'public' | 'staff' | 'card'; actor?: string | null; ip?: string | null;
}) {
  await q`insert into consent_log (establishment_id, subject_kind, subject_id, purpose, granted, text_version, source, actor, ip)
          values (${c.establishmentId}, ${c.kind}, ${c.subjectId}, ${c.purpose}, ${c.granted}, ${LEGAL_VERSION}, ${c.source}, ${c.actor ?? null}, ${c.ip ?? null})`;
}

/** Plazos de conservación: anonimiza reservas, borra datos de la lista de espera y del registro de avisos. */
export async function applyRetention(): Promise<{ reservations: number; waitlist: number; messages: number }> {
  const r = await sql`
    update reservations r set name = 'Reserva anonimizada', phone = '', email = '', notes = '', whatsapp_consent = false, anonymized_at = now()
    from establishments e
    where e.id = r.establishment_id and r.anonymized_at is null
      and r.status in ('finished', 'cancelled', 'no_show', 'seated', 'requested', 'confirmed')
      and r.starts_at < now() - make_interval(months => greatest(1, coalesce((e.privacy->>'reservationMonths')::int, ${DEFAULT_PRIVACY.reservationMonths})))
    returning r.id`;
  const w = await sql`
    update waitlist w set name = 'Anonimizado', phone = '', whatsapp_consent = false, anonymized_at = now()
    from establishments e
    where e.id = w.establishment_id and w.anonymized_at is null and w.status not in ('waiting', 'notified')
      and coalesce(w.closed_at, w.seated_at, w.created_at) < now() - make_interval(days => greatest(1, coalesce((e.privacy->>'waitlistDays')::int, ${DEFAULT_PRIVACY.waitlistDays})))
    returning w.id`;
  const m = await sql`
    delete from message_log l using establishments e
    where e.id = l.establishment_id
      and l.created_at < now() - make_interval(months => greatest(1, coalesce((e.privacy->>'messageLogMonths')::int, ${DEFAULT_PRIVACY.messageLogMonths})))
    returning l.id`;
  return { reservations: r.length, waitlist: w.length, messages: m.length };
}
