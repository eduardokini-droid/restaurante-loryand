/** Traducción automática con DeepL (opcional). Requiere la variable DEEPL_API_KEY en el servidor. */
export const LANGS = ['en', 'fr', 'de', 'it', 'pt', 'ru'] as const;
export type Lang = (typeof LANGS)[number];
const DEEPL_TARGET: Record<Lang, string> = { en: 'EN-GB', fr: 'FR', de: 'DE', it: 'IT', pt: 'PT-PT', ru: 'RU' };

export const translationAvailable = () => !!process.env.DEEPL_API_KEY;

export async function translateTexts(texts: string[], fetchImpl: typeof fetch = fetch): Promise<Record<Lang, string[]>> {
  const key = process.env.DEEPL_API_KEY!;
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const out = {} as Record<Lang, string[]>;
  for (const lang of LANGS) {
    const res = await fetchImpl(`${host}/v2/translate`, {
      method: 'POST',
      headers: { authorization: `DeepL-Auth-Key ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: texts, source_lang: 'ES', target_lang: DEEPL_TARGET[lang], preserve_formatting: true }),
    });
    if (!res.ok) throw new Error(`DeepL respondió ${res.status}`);
    const json = (await res.json()) as { translations: { text: string }[] };
    out[lang] = json.translations.map((t) => t.text);
  }
  return out;
}
