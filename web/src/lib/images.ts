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

/**
 * Versión del logotipo para la impresora de tickets: blanco y negro con tramado (Floyd-Steinberg),
 * hasta 384 puntos de ancho (unos 48 mm) y 160 de alto. 1 bit por punto, 1 = negro.
 */
export async function printBitmap(src: string): Promise<{ width: number; height: number; data: string }> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = Math.min(384 / img.naturalWidth, 160 / img.naturalHeight, 1);
  const w = Math.max(8, Math.round((img.naturalWidth * scale) / 8) * 8);
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const out = new Uint8Array((w / 8) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const black = gray[i] < 128;
      if (black) out[y * (w / 8) + (x >> 3)] |= 0x80 >> (x & 7);
      const err = gray[i] - (black ? 0 : 255);
      if (x + 1 < w) gray[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) gray[i + w - 1] += (err * 3) / 16;
        gray[i + w] += (err * 5) / 16;
        if (x + 1 < w) gray[i + w + 1] += err / 16;
      }
    }
  }
  let bin = '';
  out.forEach((b) => { bin += String.fromCharCode(b); });
  return { width: w, height: h, data: btoa(bin) };
}
