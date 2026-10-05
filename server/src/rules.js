// Правила доступа. Работают на сервере: браузеру и localStorage ничего не доверяем.

export const PUBLIC_READ = new Set([
  'books', 'comments', 'quotes', 'questions', 'votes', 'announcements', 'groupstatuses',
  'ratings', 'adaptations', 'suggestions', 'personalReviews', 'config',
]);

export const ownKey = user => `u${user.id}`;

/** Для не-админов убираем из config коды доступа. */
export function sanitizeConfig(cfg, user) {
  if (!cfg || typeof cfg !== 'object' || user.isAdmin) return cfg;
  const out = JSON.parse(JSON.stringify(cfg));
  delete out.proCode;
  if (out.bookPayInfo && typeof out.bookPayInfo === 'object') {
    for (const k of Object.keys(out.bookPayInfo)) {
      if (out.bookPayInfo[k] && typeof out.bookPayInfo[k] === 'object') delete out.bookPayInfo[k].code;
    }
  }
  return out;
}

/** null — можно читать; иначе текст ошибки. */
export function checkRead(segs, user) {
  const root = segs[0];
  if (!root) return 'forbidden';
  if (root === 'userdata') return segs[1] === ownKey(user) ? null : 'forbidden';
  if (PUBLIC_READ.has(root)) return null;
  return 'forbidden'; // notes — только через /api/notes, members — только через /api/members
}

const canon = v => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}
const asList = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const byId = list => new Map(list.filter(i => i && i.id != null).map(i => [String(i.id), i]));

/** Разница между двумя списками имён должна состоять только из имени пользователя. */
function onlyMine(oldArr, newArr, name) {
  const o = new Set(asList(oldArr)), n = new Set(asList(newArr));
  for (const v of n) if (!o.has(v) && v !== name) return false;
  for (const v of o) if (!n.has(v) && v !== name) return false;
  return true;
}

function reactionsOk(oldR, newR, name) {
  const o = oldR && typeof oldR === 'object' ? oldR : {};
  const n = newR && typeof newR === 'object' ? newR : {};
  for (const emoji of new Set([...Object.keys(o), ...Object.keys(n)])) {
    if (!onlyMine(o[emoji], n[emoji], name)) return false;
  }
  return true;
}

/**
 * Лента (комментарии, цитаты, вопросы): любой участник может добавить своё,
 * поставить/снять свою реакцию; удалять и править чужое — только админ.
 */
function guardThread(oldVal, newVal, user, nested = ['replies', 'answers']) {
  const oldMap = byId(asList(oldVal)), newList = asList(newVal);
  const newMap = byId(newList);
  for (const id of oldMap.keys()) {
    if (!newMap.has(id) && oldMap.get(id).by !== user.name) return 'нельзя удалять чужое';
  }
  for (const item of newList) {
    if (!item || typeof item !== 'object' || item.id == null) return 'неверный формат';
    const old = oldMap.get(String(item.id));
    const strip = i => { const c = { ...i }; delete c.reactions; for (const k of nested) delete c[k]; return c; };
    if (!old) {
      if (item.by !== user.name) return 'подпись не совпадает с вашим именем';
    } else if (old.by !== user.name && canon(strip(old)) !== canon(strip(item))) {
      return 'нельзя править чужое';
    } else if (old.by === user.name && item.by !== old.by) return 'нельзя менять автора';
    if (!reactionsOk(old && old.reactions, item.reactions, user.name)) return 'реакции — только от своего имени';
    for (const k of nested) {
      const err = guardThread(old && old[k], item[k], user, []);
      if (err) return err;
    }
  }
  return null;
}

function guardVotes(oldVal, newVal, user) {
  const oldMap = byId(asList(oldVal)), newList = asList(newVal);
  const newMap = byId(newList);
  for (const id of oldMap.keys()) if (!newMap.has(id)) return 'удалять варианты может только организатор';
  for (const o of newList) {
    if (!o || typeof o.title !== 'string' || o.title.length > 200 || o.id == null) return 'неверный формат';
    const old = oldMap.get(String(o.id));
    if (old && old.title !== o.title) return 'нельзя менять название';
    if (!onlyMine(old && old.votes, o.votes, user.name)) return 'голосовать можно только за себя';
  }
  return null;
}

function guardReviews(oldVal, newVal, user) {
  const others = list => canon(asList(list).filter(r => r && r.by !== user.name));
  if (others(oldVal) !== others(newVal)) return 'нельзя менять чужие отзывы';
  for (const r of asList(newVal)) if (r && r.by === user.name && typeof r.text !== 'string') return 'неверный формат';
  return null;
}

/**
 * null — запись разрешена; иначе текст ошибки.
 * oldVal нужен для сравнения «что именно изменилось».
 */
export function checkWrite(segs, newVal, oldVal, user) {
  const [root] = segs;
  if (!root) return 'forbidden';
  if (root === 'members' || root === 'notes') return 'forbidden';
  if (root === 'userdata') return segs[1] === ownKey(user) ? null : 'forbidden';
  if (user.isAdmin) return null; // организатор: всё остальное

  switch (root) {
    case 'adaptations':
      return segs.length === 2 ? null : 'forbidden';
    case 'votes':
      return segs.length === 2 && segs[1] === 'options' ? guardVotes(oldVal, newVal, user) : 'forbidden';
    case 'comments': case 'quotes': case 'questions':
      return segs.length === 2 ? guardThread(oldVal, newVal, user) : 'forbidden';
    case 'groupstatuses': case 'ratings': case 'suggestions':
      return segs.length === 3 && segs[2] === ownKey(user) ? null : 'forbidden';
    case 'personalReviews':
      return segs.length === 2 ? guardReviews(oldVal, newVal, user) : 'forbidden';
    default:
      return 'forbidden';
  }
}
