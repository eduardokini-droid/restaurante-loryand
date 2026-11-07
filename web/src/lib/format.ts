const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
export const money = (cents: number) => eur.format((cents ?? 0) / 100);
export const toCents = (v: string) => Math.round(parseFloat(v.replace(',', '.')) * 100);
export const time = (d: string | Date) => new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
export const dateTime = (d: string | Date) => new Date(d).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
export const minutesSince = (d: string) => Math.floor((Date.now() - new Date(d).getTime()) / 60000);
export const today = () => new Date().toISOString().slice(0, 10);

export const STATUS_LABEL: Record<string, string> = {
  held: 'En espera de pase', new: 'Nuevo', preparing: 'Preparando', ready: 'Listo',
  received: 'Recogido', delivered: 'Entregado', cancelled: 'Anulado',
};
export const PHYSICAL_LABEL: Record<string, string> = {
  free: 'Libre', occupied: 'Ocupada', paid_occupied: 'Pagada · aún ocupada', dirty: 'Pendiente de limpiar',
};
export const METHOD_LABEL: Record<string, string> = { cash: 'Efectivo', card: 'Tarjeta', bizum: 'Bizum' };
export const ZONE_LABEL: Record<string, string> = { salon: 'Salón', terraza: 'Terraza', barra: 'Barra', reservado: 'Reservado' };
export const DOC_LABEL: Record<string, string> = { proforma: 'Proforma', simplified: 'Factura simplificada', full: 'Factura completa' };
export const ALLERGENS: Record<string, string> = {
  gluten: 'Gluten', crustaceos: 'Crustáceos', huevos: 'Huevos', pescado: 'Pescado', cacahuetes: 'Cacahuetes',
  soja: 'Soja', lacteos: 'Lácteos', frutos_cascara: 'Frutos de cáscara', apio: 'Apio', mostaza: 'Mostaza',
  sesamo: 'Sésamo', sulfitos: 'Sulfitos', altramuces: 'Altramuces', moluscos: 'Moluscos',
};
