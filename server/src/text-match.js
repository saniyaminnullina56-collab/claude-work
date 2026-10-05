// Нормализация названий для сравнения: регистр, «ё», кавычки и знаки не мешают; слова сравниваются по основе (5 букв).
export const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
export const toks = s => norm(s).split(' ').filter(w => w.length > 2).map(w => w.slice(0, 5));
export const hasCyrillic = s => /[а-яё]/i.test(String(s || ''));
