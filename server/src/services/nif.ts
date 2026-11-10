/** Comprobación de NIF, NIE y CIF españoles (letra o dígito de control). */
const LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

export function validSpanishTaxId(raw: string): boolean {
  const v = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (/^\d{8}[A-Z]$/.test(v)) return LETTERS[Number(v.slice(0, 8)) % 23] === v[8];                     // DNI / NIF
  if (/^[XYZ]\d{7}[A-Z]$/.test(v)) {                                                                     // NIE
    const n = Number(String('XYZ'.indexOf(v[0])) + v.slice(1, 8));
    return LETTERS[n % 23] === v[8];
  }
  if (/^[KLM]\d{7}[A-Z]$/.test(v)) return LETTERS[Number(v.slice(1, 8)) % 23] === v[8];                 // NIF especiales
  const m = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(v);                                         // CIF
  if (!m) return false;
  const digits = m[2].split('').map(Number);
  let sum = 0;
  digits.forEach((d, i) => { if (i % 2 === 0) { const x = d * 2; sum += Math.floor(x / 10) + (x % 10); } else sum += d; });
  const ctrl = (10 - (sum % 10)) % 10;
  const letter = 'JABCDEFGHI'[ctrl];
  if ('KPQSNW'.includes(m[1])) return m[3] === letter;
  if ('ABEH'.includes(m[1])) return m[3] === String(ctrl);
  return m[3] === String(ctrl) || m[3] === letter;
}
