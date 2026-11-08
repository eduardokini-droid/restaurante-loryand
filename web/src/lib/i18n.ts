/** Idiomas de la carta del cliente. El español es la base; si falta una traducción se muestra en español. */
export const LANGS = [['es', 'Español'], ['en', 'English'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'], ['pt', 'Português'], ['ru', 'Русский']] as const;
export type Lang = (typeof LANGS)[number][0];

const T: Record<string, Partial<Record<Lang, string>>> = {
  menu: { es: 'Carta', en: 'Menu', fr: 'Carte', de: 'Speisekarte', it: 'Menù', pt: 'Ementa', ru: 'Меню' },
  myOrder: { es: 'Mi pedido', en: 'My order', fr: 'Ma commande', de: 'Meine Bestellung', it: 'Il mio ordine', pt: 'O meu pedido', ru: 'Мой заказ' },
  callWaiter: { es: 'Llamar al camarero', en: 'Call the waiter', fr: 'Appeler le serveur', de: 'Kellner rufen', it: 'Chiama il cameriere', pt: 'Chamar o empregado', ru: 'Позвать официанта' },
  wantPay: { es: 'Quiero pagar', en: 'I want to pay', fr: 'Je veux payer', de: 'Ich möchte zahlen', it: 'Vorrei pagare', pt: 'Quero pagar', ru: 'Хочу оплатить' },
  table: { es: 'Mesa', en: 'Table', fr: 'Table', de: 'Tisch', it: 'Tavolo', pt: 'Mesa', ru: 'Стол' },
  contains: { es: 'Contiene', en: 'Contains', fr: 'Contient', de: 'Enthält', it: 'Contiene', pt: 'Contém', ru: 'Содержит' },
  viewOrder: { es: 'Ver pedido', en: 'View order', fr: 'Voir la commande', de: 'Bestellung ansehen', it: 'Vedi ordine', pt: 'Ver pedido', ru: 'Посмотреть заказ' },
  yourOrder: { es: 'Tu pedido', en: 'Your order', fr: 'Votre commande', de: 'Ihre Bestellung', it: 'Il tuo ordine', pt: 'O seu pedido', ru: 'Ваш заказ' },
  send: { es: 'Enviar pedido', en: 'Send order', fr: 'Envoyer la commande', de: 'Bestellung senden', it: 'Invia ordine', pt: 'Enviar pedido', ru: 'Отправить заказ' },
  add: { es: 'Añadir', en: 'Add', fr: 'Ajouter', de: 'Hinzufügen', it: 'Aggiungi', pt: 'Adicionar', ru: 'Добавить' },
  allergyNote: {
    es: '¿Alergias o intolerancias? Pregunta al personal antes de pedir. Las fotos son orientativas y no permiten descartar trazas.',
    en: 'Allergies or intolerances? Please ask our staff before ordering. Photos are for illustration only.',
    fr: 'Allergies ou intolérances ? Demandez au personnel avant de commander. Les photos ne sont qu’indicatives.',
    de: 'Allergien oder Unverträglichkeiten? Bitte fragen Sie vor der Bestellung unser Personal. Fotos dienen nur zur Veranschaulichung.',
    it: 'Allergie o intolleranze? Chiedi al personale prima di ordinare. Le foto sono indicative.',
    pt: 'Alergias ou intolerâncias? Pergunte à equipa antes de pedir. As fotos são meramente ilustrativas.',
    ru: 'Аллергия или непереносимость? Спросите персонал перед заказом. Фото носят иллюстративный характер.',
  },
};
export const t = (key: keyof typeof T, lang: Lang) => T[key][lang] ?? T[key].es ?? key;

export function trProduct<P extends { name: string; description: string; translations?: Record<string, { name?: string; description?: string }> }>(p: P, lang: Lang) {
  if (lang === 'es') return { name: p.name, description: p.description };
  const x = p.translations?.[lang];
  return { name: x?.name || p.name, description: x?.description || p.description };
}
export const trCategory = (c: { name: string; translations?: Record<string, string> }, lang: Lang) => (lang === 'es' ? c.name : c.translations?.[lang] || c.name);

const ALLERGEN_NAMES: Record<string, Partial<Record<Lang, string>>> = {
  gluten: { en: 'Gluten', fr: 'Gluten', de: 'Gluten', it: 'Glutine', pt: 'Glúten', ru: 'Глютен' },
  crustaceos: { en: 'Crustaceans', fr: 'Crustacés', de: 'Krebstiere', it: 'Crostacei', pt: 'Crustáceos', ru: 'Ракообразные' },
  huevos: { en: 'Eggs', fr: 'Œufs', de: 'Eier', it: 'Uova', pt: 'Ovos', ru: 'Яйца' },
  pescado: { en: 'Fish', fr: 'Poisson', de: 'Fisch', it: 'Pesce', pt: 'Peixe', ru: 'Рыба' },
  cacahuetes: { en: 'Peanuts', fr: 'Arachides', de: 'Erdnüsse', it: 'Arachidi', pt: 'Amendoins', ru: 'Арахис' },
  soja: { en: 'Soy', fr: 'Soja', de: 'Soja', it: 'Soia', pt: 'Soja', ru: 'Соя' },
  lacteos: { en: 'Milk', fr: 'Lait', de: 'Milch', it: 'Latte', pt: 'Leite', ru: 'Молоко' },
  frutos_cascara: { en: 'Tree nuts', fr: 'Fruits à coque', de: 'Schalenfrüchte', it: 'Frutta a guscio', pt: 'Frutos de casca rija', ru: 'Орехи' },
  apio: { en: 'Celery', fr: 'Céleri', de: 'Sellerie', it: 'Sedano', pt: 'Aipo', ru: 'Сельдерей' },
  mostaza: { en: 'Mustard', fr: 'Moutarde', de: 'Senf', it: 'Senape', pt: 'Mostarda', ru: 'Горчица' },
  sesamo: { en: 'Sesame', fr: 'Sésame', de: 'Sesam', it: 'Sesamo', pt: 'Sésamo', ru: 'Кунжут' },
  sulfitos: { en: 'Sulphites', fr: 'Sulfites', de: 'Sulfite', it: 'Solfiti', pt: 'Sulfitos', ru: 'Сульфиты' },
  altramuces: { en: 'Lupin', fr: 'Lupin', de: 'Lupinen', it: 'Lupini', pt: 'Tremoço', ru: 'Люпин' },
  moluscos: { en: 'Molluscs', fr: 'Mollusques', de: 'Weichtiere', it: 'Molluschi', pt: 'Moluscos', ru: 'Моллюски' },
};
export const allergenName = (key: string, lang: Lang, spanish: string) => (lang === 'es' ? spanish : ALLERGEN_NAMES[key]?.[lang] ?? spanish);
