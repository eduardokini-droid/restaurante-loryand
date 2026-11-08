/**
 * Etiquetas de mesa (QR + NFC) con el diseño de Loryand: 8 por hoja A4 (2 × 4), en milímetros.
 * Se genera un documento HTML independiente que se muestra en vista previa y se imprime tal cual.
 */
export interface LabelData { table: string; qr: string }
export interface LabelOptions { establishment: string; tagline: string; cropMarks?: boolean }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const C = {
  green: '#1f3a2b', greenLine: '#2c4a38', cream: '#f5f0e3', gold: '#d0a14a', goldSoft: '#b9a06a',
  red: '#b5452f', ink: '#1f3a2b', pattern: '#e4dcc4', border: '#22382b',
};

/** Logotipo: anillo dorado, arco rojo y la «L». */
const logo = `
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="50" cy="50" r="46" fill="none" stroke="${C.gold}" stroke-width="1.6" opacity=".55"/>
  <circle cx="50" cy="50" r="38" fill="none" stroke="#14271d" stroke-width="7"/>
  <path d="M 50 12 A 38 38 0 1 1 13.5 39" fill="none" stroke="${C.red}" stroke-width="6.5" stroke-linecap="round"/>
  <path d="M 39 29 L 39 68 L 63 68" fill="none" stroke="#fbf6ea" stroke-width="10" stroke-linejoin="miter"/>
</svg>`;

/** Trama de lazos de fondo (muy suave). */
const pattern = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">
  <g fill="none" stroke="${C.pattern}" stroke-width="1.4">
    <path d="M0 30 C 10 10, 25 10, 30 30 S 50 50, 60 30"/>
    <path d="M30 0 C 50 10, 50 25, 30 30 S 10 50, 30 60"/>
    <circle cx="30" cy="30" r="6"/>
  </g>
</svg>`)}`;

/** Símbolo NFC: triángulo rojo apuntando al móvil y ondas. */
const nfc = `
<svg viewBox="0 0 60 50" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M4 25 L14 18 L14 32 Z" fill="${C.red}"/>
  <g fill="none" stroke="${C.ink}" stroke-width="4.2" stroke-linecap="round">
    <path d="M26 15 Q 32 25 26 35"/>
    <path d="M35 9 Q 45 25 35 41"/>
    <path d="M44 3 Q 58 25 44 47"/>
  </g>
</svg>`;

/** Marcas de corte en las cuatro esquinas, fuera de la etiqueta, alineadas con sus bordes. */
const MARKS = ['tl-h', 'tl-v', 'tr-h', 'tr-v', 'bl-h', 'bl-v', 'br-h', 'br-v'].map((c) => `<i class="mk ${c}"></i>`).join('');

function card(l: LabelData, o: LabelOptions): string {
  const n = esc(l.table);
  const numSize = n.length <= 2 ? 15 : n.length === 3 ? 11 : 8;
  return `
  <div class="card">${o.cropMarks === false ? '' : MARKS}
    <div class="side">
      <div class="logo">${logo}</div>
      <div class="brand">LORYAND</div>
      <div class="brand-sub">HOSTELERÍA DIGITAL</div>
      <div class="rule"></div>
      <div class="mesa">MESA</div>
      <div class="num" style="font-size:${numSize}mm">${n}</div>
      <div class="pill">NFC + QR</div>
    </div>
    <div class="main">
      <div class="name">${esc(o.establishment)}</div>
      ${o.tagline ? `<div class="tagline">${esc(o.tagline)}</div>` : ''}
      <div class="row">
        <div class="qr"><img src="${l.qr}" alt="QR mesa ${n}"></div>
        <div class="nfc">${nfc}<div class="nfc-text">ACERCA<br>TU MÓVIL</div></div>
      </div>
      <div class="cta">ESCANEA PARA VER LA CARTA Y PEDIR</div>
      <div class="sub">o acerca tu móvil al símbolo NFC</div>
      <div class="note">Tu pedido llegará directamente al local</div>
    </div>
  </div>`;
}

export function labelsHtml(labels: LabelData[], o: LabelOptions): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas de mesa · ${esc(o.establishment)}</title>
<style>
  @page { size: A4; margin: 7mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; background: #fff; font-family: "Helvetica Neue", Arial, "DejaVu Sans", sans-serif; }
  /* Separación suficiente para que las marcas de corte de etiquetas vecinas no se toquen. */
  .sheet { display: grid; grid-template-columns: 94mm 94mm; column-gap: 6mm; row-gap: 5mm; justify-content: center; padding: 0; }
  .mk { position: absolute; background: #3a3a3a; display: block; }
  .mk[class*="-h"] { width: 1.8mm; height: .15mm; }
  .mk[class*="-v"] { width: .15mm; height: 1.8mm; }
  /* Cada marca prolonga el borde de la etiqueta (alineada con él) y empieza a 0,6 mm de la esquina. */
  .tl-h { top: -.075mm; left: -2.4mm; } .tl-v { top: -2.4mm; left: -.075mm; }
  .tr-h { top: -.075mm; right: -2.4mm; } .tr-v { top: -2.4mm; right: -.075mm; }
  .bl-h { bottom: -.075mm; left: -2.4mm; } .bl-v { bottom: -2.4mm; left: -.075mm; }
  .br-h { bottom: -.075mm; right: -2.4mm; } .br-v { bottom: -2.4mm; right: -.075mm; }
  .card { width: 94mm; height: 66mm; border: .7mm solid ${C.border}; border-radius: 3.2mm; padding: 1.4mm; background: #fff; display: flex; break-inside: avoid; page-break-inside: avoid; position: relative; }
  .card::before { content: ""; position: absolute; inset: 1.4mm; border: .35mm solid ${C.goldSoft}; border-radius: 2.2mm; pointer-events: none; }
  .side { width: 29mm; flex: none; background: ${C.green}; border-radius: 2mm 0 0 2mm; color: #fbf6ea; display: flex; flex-direction: column; align-items: center; padding: 3mm 2mm 2.6mm; }
  .logo { width: 15mm; height: 15mm; }
  .logo svg { width: 100%; height: 100%; display: block; }
  .brand { margin-top: 1.4mm; font-weight: 800; font-size: 3.4mm; letter-spacing: .25mm; }
  .brand-sub { font-size: 1.35mm; letter-spacing: .3mm; color: ${C.goldSoft}; margin-top: .4mm; }
  .rule { width: 80%; height: .25mm; background: ${C.gold}; opacity: .6; margin: 1.8mm 0 1.6mm; }
  .mesa { font-weight: 800; font-size: 3mm; letter-spacing: .3mm; }
  .num { font-weight: 900; color: ${C.gold}; line-height: 1; margin: .6mm 0 auto; display: flex; align-items: center; flex: 1; }
  .pill { background: ${C.red}; color: #fff; font-weight: 800; font-size: 2.1mm; letter-spacing: .15mm; padding: .9mm 3.6mm; border-radius: 3mm; }
  .main { flex: 1; border-radius: 0 2mm 2mm 0; background-color: ${C.cream}; background-image: url("${pattern}"); background-size: 13mm 13mm; display: flex; flex-direction: column; align-items: center; padding: 3mm 2.5mm 2mm; text-align: center; }
  .name { font-weight: 900; font-size: 5mm; letter-spacing: .3mm; color: ${C.ink}; text-transform: uppercase; line-height: 1.05; max-width: 100%; overflow: hidden; }
  .tagline { font-size: 1.55mm; letter-spacing: .25mm; color: ${C.red}; text-transform: uppercase; font-weight: 700; margin-top: .6mm; }
  .row { display: flex; align-items: center; gap: 2.5mm; margin-top: 2mm; }
  .qr { width: 30mm; height: 30mm; background: #fff; border-radius: 1.6mm; padding: .4mm; box-shadow: 0 0 0 .3mm #e6dfcb; }
  .qr img { width: 100%; height: 100%; display: block; image-rendering: pixelated; }
  .nfc { width: 14mm; display: flex; flex-direction: column; align-items: center; }
  .nfc svg { width: 13mm; height: 11mm; }
  .nfc-text { font-weight: 800; font-size: 1.9mm; line-height: 1.25; color: ${C.ink}; margin-top: 1mm; }
  .cta { font-weight: 800; font-size: 2.05mm; color: ${C.ink}; margin-top: 2mm; letter-spacing: .05mm; }
  .sub { font-size: 1.55mm; color: #4b5a4f; margin-top: .5mm; }
  .note { font-size: 1.45mm; color: ${C.red}; margin-top: .4mm; }
  @media screen { body { background: #e9e6df; } .sheet { padding: 6mm 0; } }
</style></head><body><div class="sheet">${labels.map((l) => card(l, o)).join('')}</div></body></html>`;
}
