import { cleanNote } from './notes-clean.js';

const oldKey = name => String(name || 'user').replace(/[^a-zA-Zа-яёА-ЯЁ0-9]/g, '_');
const toList = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

/**
 * Преобразует экспорт Firebase Realtime Database в дерево нашей базы.
 * nameMap: { "Имя в клубе": telegramId } — чтобы личные данные (прогресс, оценки, статусы) перешли к нужной участнице.
 * Данные тех, кого нет в nameMap, не переносятся (им придётся отметить заново).
 */
export function convertFirebase(fb, nameMap = {}) {
  const keyMap = {};
  for (const [name, id] of Object.entries(nameMap)) keyMap[oldKey(name)] = `u${id}`;
  const out = {};

  for (const r of ['books', 'votes', 'announcements', 'adaptations', 'config', 'personalReviews']) {
    if (fb[r] != null) out[r] = fb[r];
  }
  if (out.announcements) out.announcements = toList(out.announcements);
  if (out.votes && out.votes.options) out.votes.options = toList(out.votes.options);
  if (out.books && Array.isArray(out.books)) out.books = Object.fromEntries(out.books.filter(Boolean).map(b => [b.id, b]));

  // ленты: в Firebase их записывали и как массив, и как объект «ключ → запись»
  for (const r of ['comments', 'quotes', 'questions']) {
    if (!fb[r]) continue;
    out[r] = {};
    for (const [bid, items] of Object.entries(fb[r])) out[r][bid] = toList(items);
  }
  for (const r of ['ratings', 'groupstatuses', 'suggestions']) {
    if (!fb[r]) continue;
    out[r] = {};
    for (const [bid, byUser] of Object.entries(fb[r])) {
      for (const [k, v] of Object.entries(byUser || {})) {
        if (keyMap[k]) (out[r][bid] ||= {})[keyMap[k]] = v;
      }
    }
  }
  if (fb.userdata) {
    out.userdata = {};
    for (const [k, v] of Object.entries(fb.userdata)) if (keyMap[k]) out.userdata[keyMap[k]] = v;
  }
  if (fb.notes) {
    out.notes = {};
    for (const [bid, n] of Object.entries(fb.notes)) {
      if (n && typeof n.content === 'string') out.notes[bid] = { content: cleanNote(n.content), updatedAt: n.updatedAt || '' };
    }
  }
  return out;
}
