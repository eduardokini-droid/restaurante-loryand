import { api } from './api';

/**
 * Reduce una foto en el propio dispositivo antes de subirla: así una foto del móvil de 5 MB
 * se queda en 50–150 KB. Los logotipos conservan la transparencia (WebP o PNG).
 */
export async function shrinkImage(file: File, kind: 'logo' | 'product'): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|heic|heif)$/i.test(file.type) && !/\.(png|jpe?g|webp|heic)$/i.test(file.name)) {
    throw new Error('Elige una imagen (JPG, PNG o WebP)');
  }
  const max = kind === 'logo' ? 512 : 900;
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('No se puede leer esta imagen. Prueba con una foto JPG o PNG.'); });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  if (kind === 'product') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const limit = kind === 'logo' ? 290_000 : 440_000;
  const tries: [string, number][] = kind === 'logo' ? [['image/webp', 0.9], ['image/png', 1], ['image/webp', 0.75]] : [['image/webp', 0.82], ['image/jpeg', 0.82], ['image/jpeg', 0.65]];
  for (const [type, q] of tries) {
    const url = canvas.toDataURL(type, q);
    // Algunos navegadores no saben generar WebP y devuelven PNG: se comprueba el tipo real.
    if (!url.startsWith(`data:${type}`)) continue;
    if (url.length * 0.75 <= limit) return url;
  }
  throw new Error('La imagen es demasiado grande incluso reducida. Prueba con otra.');
}

export async function uploadImage(file: File, kind: 'logo' | 'product'): Promise<{ id: string; url: string }> {
  const dataUrl = await shrinkImage(file, kind);
  return api('/api/admin/images', { body: { kind, dataUrl } });
}
