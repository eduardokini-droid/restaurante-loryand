/**
 * Adeudos directos SEPA (esquema básico CORE): validación de IBAN, identificador de acreedor
 * y fichero de remesa ISO 20022 pain.008.001.02, el que aceptan los bancos españoles.
 */

const mod97 = (digits: string) => {
  let r = 0;
  for (const ch of digits) r = (r * 10 + Number(ch)) % 97;
  return r;
};
/** Letras a números (A=10 … Z=35), como piden IBAN y el identificador de acreedor. */
const toDigits = (s: string) => s.toUpperCase().split('').map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join('');

export const cleanIban = (iban: string) => iban.replace(/[\s-]/g, '').toUpperCase();

export function validIban(raw: string): boolean {
  const iban = cleanIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('ES') && iban.length !== 24) return false;
  return mod97(toDigits(iban.slice(4) + iban.slice(0, 4))) === 1;
}

/**
 * Identificador de acreedor SEPA a partir del NIF (norma AT-02): ES + dígitos de control + sufijo + NIF.
 * El sufijo (3 caracteres, por defecto «000») no entra en el cálculo.
 */
export function creditorId(nif: string, suffix = '000', country = 'ES'): string {
  const id = nif.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const check = 98 - mod97(toDigits(`${id}${country}00`));
  return `${country}${String(check).padStart(2, '0')}${suffix.toUpperCase().padEnd(3, '0').slice(0, 3)}${id}`;
}
export function validCreditorId(cid: string): boolean {
  const c = cid.replace(/\s/g, '').toUpperCase();
  const m = /^([A-Z]{2})(\d{2})([A-Z0-9]{3})([A-Z0-9]{1,28})$/.exec(c);
  if (!m) return false;
  return mod97(toDigits(`${m[4]}${m[1]}${m[2]}`)) === 1;
}

/** Texto apto para SEPA: solo el juego de caracteres latino básico, sin tildes ni eñes. */
export function sepaText(s: string, max: number): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const amount = (cents: number) => (cents / 100).toFixed(2);

export interface SepaDebit {
  endToEndId: string; amountCents: number; mandateId: string; mandateDate: string;
  debtorName: string; debtorIban: string; concept: string;
}

export function buildPain008(o: {
  msgId: string; createdAt: Date; collectionDate: string;
  creditor: { name: string; iban: string; bic?: string; id: string };
  debits: SepaDebit[];
}): string {
  const total = o.debits.reduce((s, d) => s + d.amountCents, 0);
  const n = o.debits.length;
  const name = x(sepaText(o.creditor.name, 70));
  const bic = o.creditor.bic?.trim()
    ? `<FinInstnId><BIC>${x(o.creditor.bic.trim().toUpperCase())}</BIC></FinInstnId>`
    : '<FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId>';
  const tx = o.debits.map((d) => `
      <DrctDbtTxInf>
        <PmtId><EndToEndId>${x(sepaText(d.endToEndId, 35))}</EndToEndId></PmtId>
        <InstdAmt Ccy="EUR">${amount(d.amountCents)}</InstdAmt>
        <DrctDbtTx><MndtRltdInf><MndtId>${x(sepaText(d.mandateId, 35))}</MndtId><DtOfSgntr>${d.mandateDate}</DtOfSgntr></MndtRltdInf></DrctDbtTx>
        <DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>
        <Dbtr><Nm>${x(sepaText(d.debtorName, 70))}</Nm></Dbtr>
        <DbtrAcct><Id><IBAN>${cleanIban(d.debtorIban)}</IBAN></Id></DbtrAcct>
        <RmtInf><Ustrd>${x(sepaText(d.concept, 140))}</Ustrd></RmtInf>
      </DrctDbtTxInf>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${x(sepaText(o.msgId, 35))}</MsgId>
      <CreDtTm>${o.createdAt.toISOString().slice(0, 19)}</CreDtTm>
      <NbOfTxs>${n}</NbOfTxs>
      <CtrlSum>${amount(total)}</CtrlSum>
      <InitgPty><Nm>${name}</Nm><Id><OrgId><Othr><Id>${x(o.creditor.id)}</Id></Othr></OrgId></Id></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${x(sepaText(o.msgId, 35))}</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <BtchBookg>true</BtchBookg>
      <NbOfTxs>${n}</NbOfTxs>
      <CtrlSum>${amount(total)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>RCUR</SeqTp></PmtTpInf>
      <ReqdColltnDt>${o.collectionDate}</ReqdColltnDt>
      <Cdtr><Nm>${name}</Nm></Cdtr>
      <CdtrAcct><Id><IBAN>${cleanIban(o.creditor.iban)}</IBAN></Id></CdtrAcct>
      <CdtrAgt>${bic}</CdtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtrSchmeId><Id><PrvtId><Othr><Id>${x(o.creditor.id)}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>${tx}
    </PmtInf>
  </CstmrDrctDbtInitn>
</Document>
`;
}
