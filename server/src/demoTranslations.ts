import { sql } from './db.js';

/** Traducciones de la carta de demostración a los 6 idiomas extranjeros (en, fr, de, it, pt, ru). */
type Tr = Record<'en' | 'fr' | 'de' | 'it' | 'pt' | 'ru', [string, string]>;
const PRODUCTS: Record<string, Tr> = {
  'Croquetas caseras': { en: ['Homemade croquettes', 'Iberian ham, 8 pieces'], fr: ['Croquettes maison', 'Jambon ibérique, 8 pièces'], de: ['Hausgemachte Kroketten', 'Iberischer Schinken, 8 Stück'], it: ['Crocchette fatte in casa', 'Prosciutto iberico, 8 pezzi'], pt: ['Croquetes caseiros', 'Presunto ibérico, 8 unidades'], ru: ['Домашние крокеты', 'Хамон иберико, 8 шт.'] },
  'Ensalada de temporada': { en: ['Seasonal salad', 'Tomato, tuna belly and red onion'], fr: ['Salade de saison', 'Tomate, ventrèche de thon et oignon rouge'], de: ['Saisonaler Salat', 'Tomate, Thunfischbauch und rote Zwiebel'], it: ['Insalata di stagione', 'Pomodoro, ventresca di tonno e cipolla rossa'], pt: ['Salada da época', 'Tomate, ventresca de atum e cebola roxa'], ru: ['Сезонный салат', 'Помидоры, брюшко тунца и красный лук'] },
  'Patatas bravas': { en: ['Patatas bravas', 'Fried potatoes with spicy sauce and aioli'], fr: ['Patatas bravas', 'Pommes de terre, sauce piquante et aïoli'], de: ['Patatas bravas', 'Bratkartoffeln mit scharfer Soße und Aioli'], it: ['Patatas bravas', 'Patate fritte con salsa piccante e aioli'], pt: ['Batatas bravas', 'Batatas fritas com molho picante e aioli'], ru: ['Патотас бравас', 'Жареный картофель с острым соусом и айоли'] },
  'Entrecot a la brasa': { en: ['Grilled entrecôte', '300 g with potatoes and peppers'], fr: ['Entrecôte grillée', '300 g avec pommes de terre et poivrons'], de: ['Entrecôte vom Grill', '300 g mit Kartoffeln und Paprika'], it: ['Controfiletto alla brace', '300 g con patate e peperoni'], pt: ['Entrecôte grelhado', '300 g com batatas e pimentos'], ru: ['Антрекот на гриле', '300 г с картофелем и перцем'] },
  'Merluza a la gallega': { en: ['Galician-style hake', 'With boiled potatoes and paprika garlic oil'], fr: ['Merlu à la galicienne', 'Avec pommes de terre et huile au paprika'], de: ['Seehecht nach galicischer Art', 'Mit Kartoffeln und Paprika-Knoblauchöl'], it: ['Nasello alla galiziana', 'Con patate e olio all’aglio e paprika'], pt: ['Pescada à galega', 'Com batatas cozidas e azeite de colorau'], ru: ['Хек по-галисийски', 'С отварным картофелем и паприкой'] },
  'Arroz negro': { en: ['Black rice', 'Minimum 2 people, price per serving'], fr: ['Riz noir', 'Minimum 2 personnes, prix par portion'], de: ['Schwarzer Reis', 'Ab 2 Personen, Preis pro Portion'], it: ['Riso nero', 'Minimo 2 persone, prezzo a porzione'], pt: ['Arroz negro', 'Mínimo 2 pessoas, preço por dose'], ru: ['Чёрный рис', 'Минимум на 2 человек, цена за порцию'] },
  'Tarta de queso': { en: ['Cheesecake', 'Baked and creamy'], fr: ['Gâteau au fromage', 'Cuit au four, crémeux'], de: ['Käsekuchen', 'Gebacken und cremig'], it: ['Torta al formaggio', 'Al forno, cremosa'], pt: ['Tarte de queijo', 'No forno, cremosa'], ru: ['Чизкейк', 'Запечённый, нежный'] },
  'Flan casero': { en: ['Homemade flan', ''], fr: ['Flan maison', ''], de: ['Hausgemachter Flan', ''], it: ['Crème caramel della casa', ''], pt: ['Pudim caseiro', ''], ru: ['Домашний флан', ''] },
  'Refresco': { en: ['Soft drink', '33 cl'], fr: ['Boisson gazeuse', '33 cl'], de: ['Erfrischungsgetränk', '33 cl'], it: ['Bibita', '33 cl'], pt: ['Refrigerante', '33 cl'], ru: ['Газированный напиток', '33 мл'] },
  'Agua mineral': { en: ['Mineral water', '50 cl'], fr: ['Eau minérale', '50 cl'], de: ['Mineralwasser', '50 cl'], it: ['Acqua minerale', '50 cl'], pt: ['Água mineral', '50 cl'], ru: ['Минеральная вода', '50 мл'] },
  'Caña': { en: ['Small draught beer', ''], fr: ['Demi de bière', ''], de: ['Kleines Bier vom Fass', ''], it: ['Birra piccola alla spina', ''], pt: ['Imperial', ''], ru: ['Разливное пиво (маленькое)', ''] },
  'Copa de vino': { en: ['Glass of wine', ''], fr: ['Verre de vin', ''], de: ['Glas Wein', ''], it: ['Calice di vino', ''], pt: ['Copo de vinho', ''], ru: ['Бокал вина', ''] },
  'Café': { en: ['Coffee', ''], fr: ['Café', ''], de: ['Kaffee', ''], it: ['Caffè', ''], pt: ['Café', ''], ru: ['Кофе', ''] },
};
const CATEGORIES: Record<string, Record<keyof Tr, string>> = {
  Comida: { en: 'Food', fr: 'Plats', de: 'Speisen', it: 'Cucina', pt: 'Comida', ru: 'Еда' },
  Entrantes: { en: 'Starters', fr: 'Entrées', de: 'Vorspeisen', it: 'Antipasti', pt: 'Entradas', ru: 'Закуски' },
  Principales: { en: 'Main courses', fr: 'Plats principaux', de: 'Hauptgerichte', it: 'Secondi', pt: 'Pratos principais', ru: 'Основные блюда' },
  Postres: { en: 'Desserts', fr: 'Desserts', de: 'Nachspeisen', it: 'Dolci', pt: 'Sobremesas', ru: 'Десерты' },
  Bebidas: { en: 'Drinks', fr: 'Boissons', de: 'Getränke', it: 'Bevande', pt: 'Bebidas', ru: 'Напитки' },
  Refrescos: { en: 'Soft drinks', fr: 'Boissons fraîches', de: 'Erfrischungsgetränke', it: 'Bibite', pt: 'Refrigerantes', ru: 'Безалкогольные напитки' },
  'Vinos y cervezas': { en: 'Wines and beers', fr: 'Vins et bières', de: 'Weine und Biere', it: 'Vini e birre', pt: 'Vinhos e cervejas', ru: 'Вино и пиво' },
  Cafés: { en: 'Coffees', fr: 'Cafés', de: 'Kaffee', it: 'Caffè', pt: 'Cafés', ru: 'Кофе' },
};

/** Aplica las traducciones a la carta del local «demo». Se puede repetir sin problema: solo completa idiomas que falten. */
export async function applyDemoTranslations(slug = 'demo') {
  const [e] = await sql`select id from establishments where slug = ${slug}`;
  if (!e) return 0;
  let n = 0;
  for (const [name, tr] of Object.entries(PRODUCTS)) {
    const t = Object.fromEntries(Object.entries(tr).map(([l, [nm, d]]) => [l, { name: nm, description: d }]));
    const r = await sql`update products set translations = ${sql.json(t)} || coalesce(translations, '{}'::jsonb)
                        where establishment_id = ${e.id} and name = ${name} returning id`;
    n += r.length;
  }
  for (const [name, tr] of Object.entries(CATEGORIES)) {
    await sql`update categories set translations = ${sql.json(tr)} || coalesce(translations, '{}'::jsonb) where establishment_id = ${e.id} and name = ${name}`;
  }
  return n;
}
