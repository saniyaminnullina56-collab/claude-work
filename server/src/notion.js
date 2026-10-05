// Синхронизация конспектов из Notion (только чтение): страницы под «Читальней» → тексты конспектов в базе.
import { cleanNote } from './notes-clean.js';

const API = 'https://api.notion.com/v1';
const SECTION_RE = /^конспекты по прочитанным книгам/i;
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

export function createNotion({ token, fetchImpl = fetch, sleep = defaultSleep, minGapMs = 350 }) {
  let last = 0;
  async function req(path, init = {}, attempt = 0) {
    const wait = last + minGapMs - Date.now(); // лимит Notion: ~3 запроса в секунду
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetchImpl(API + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' },
    });
    if (res.status === 429 && attempt < 5) {
      await sleep((Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 2) * 1000);
      return req(path, init, attempt + 1);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || `Notion ${res.status}`); e.status = res.status; e.code = data.code; throw e; }
    return data;
  }
  async function children(blockId) {
    const out = []; let cursor;
    do {
      const d = await req(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
      out.push(...d.results); cursor = d.has_more ? d.next_cursor : null;
    } while (cursor);
    return out;
  }
  return { me: () => req('/users/me'), page: id => req(`/pages/${id}`), children, search: body => req('/search', { method: 'POST', body: JSON.stringify(body) }) };
}

// ── блоки Notion → текст, понятный интерфейсу ──
const rich = rt => (rt || []).map(t => {
  let s = t.plain_text || '';
  if (t.annotations && t.annotations.bold && s.trim()) s = `**${s.trim()}** `;
  return s;
}).join('').replace(/ +\n/g, '\n').trim();

export async function blocksToMarkdown(blocks, getChildren) {
  const lines = [];
  let num = 0;
  for (const b of blocks) {
    const d = b[b.type] || {};
    num = b.type === 'numbered_list_item' ? num + 1 : 0;
    const kids = async () => (b.has_children && b.type !== 'child_page' ? blocksToMarkdown(await getChildren(b.id), getChildren) : '');
    switch (b.type) {
      case 'paragraph': lines.push(rich(d.rich_text)); lines.push(await kids()); break;
      case 'heading_1': lines.push('# ' + rich(d.rich_text)); lines.push(await kids()); break;
      case 'heading_2': lines.push('## ' + rich(d.rich_text)); lines.push(await kids()); break;
      case 'heading_3': lines.push('### ' + rich(d.rich_text)); lines.push(await kids()); break;
      case 'bulleted_list_item': lines.push('- ' + rich(d.rich_text)); lines.push(await kids()); break;
      case 'numbered_list_item': lines.push(`${num}. ` + rich(d.rich_text)); lines.push(await kids()); break;
      case 'to_do': lines.push(`- ${d.checked ? '☑' : '☐'} ` + rich(d.rich_text)); lines.push(await kids()); break;
      case 'quote': lines.push('> ' + rich(d.rich_text)); lines.push(await kids()); break;
      case 'callout': {
        const icon = (d.icon && d.icon.emoji) || '💡';
        lines.push(`<callout icon="${icon}">\n${[rich(d.rich_text), await kids()].filter(Boolean).join('\n')}\n</callout>`);
        break;
      }
      case 'toggle': lines.push('**' + rich(d.rich_text) + '**'); lines.push(await kids()); break;
      case 'divider': lines.push('---'); break;
      case 'code': lines.push(rich(d.rich_text)); break;
      case 'table_row': lines.push((d.cells || []).map(c => rich(c)).join(' | ')); break;
      case 'table': case 'column_list': case 'column': lines.push(await kids()); break;
      default: break; // картинки, файлы, вложенные страницы, закладки — пропускаем
    }
  }
  return lines.filter(l => l !== '').join('\n');
}

// ── сопоставление страницы с книгой каталога ──
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(w => w.length > 2).map(w => w.slice(0, 5));

export function matchBook(pageTitle, books) {
  const pt = new Set(toks(pageTitle));
  let best = null;
  for (const b of books) {
    const bt = toks(b.title);
    if (!bt.length) continue;
    const score = bt.filter(t => pt.has(t)).length / bt.length;
    if (score < 0.99 && !(score >= 0.7 && bt.length >= 3)) continue;
    if (!best || score > best.score || (score === best.score && bt.length > best.len)) best = { id: b.id, score, len: bt.length };
  }
  return best ? best.id : null;
}

/** Страница → название книги и автор, если их удаётся вычленить (для создания новой книги). */
export function guessBook(pageTitle) {
  let t = String(pageTitle || '').replace(/[«»“”"]/g, ' ').trim();
  let m;
  if ((m = /^(.+?)\s*_\s*(.+)$/.exec(t))) { // «Название_Автор» или «Автор _ Название» — определяем по числу слов
    const [a, b] = [m[1].trim(), m[2].trim()];
    const looksAuthor = s => /^[А-ЯЁA-Z][а-яёa-z.]+(\s+[А-ЯЁA-Z][а-яёa-z.]+){0,2}$/.test(s) && s.split(/\s+/).length <= 3;
    return looksAuthor(a) && !looksAuthor(b) ? { title: b, author: a } : { title: a.replace(/_.*$/, '').trim(), author: b.replace(/_.*$/, '').trim() };
  }
  return { title: t.replace(/\s+/g, ' '), author: '' };
}

/**
 * Один проход синхронизации. Состояние хранится в корнях notionState (служебное) и notionInbox
 * (страницы без книги). Читать их может только организатор — через /api/admin/notion.
 */
export async function syncNotion({ store, notion, rootPageId, now = () => new Date() }) {
  const state = store.get(['notionState']).value || { pages: {}, bindings: {} };
  state.pages ||= {}; state.bindings ||= {};
  const inbox = store.get(['notionInbox']).value || {};
  const booksVal = store.get(['books']).value || {};
  const books = (Array.isArray(booksVal) ? booksVal : Object.values(booksVal)).filter(b => b && !b.personal);
  const result = { matched: 0, updated: 0, unchanged: 0, inbox: 0, duplicates: [], errors: [] };

  const sections = (await notion.children(rootPageId)).filter(b => b.type === 'child_page' && SECTION_RE.test(b.child_page.title));
  const pages = [];
  for (const sec of sections) {
    for (const b of await notion.children(sec.id)) {
      if (b.type !== 'child_page') continue;
      let edited = b.last_edited_time; // точное время правки даёт сама страница
      try { if (notion.page) edited = (await notion.page(b.id)).last_edited_time || edited; } catch { /* оставляем время блока */ }
      pages.push({ id: b.id, title: b.child_page.title.trim(), edited, section: sec.child_page.title });
    }
  }
  if (!sections.length) throw Object.assign(new Error('Не найдены страницы «Конспекты по прочитанным книгам». Интеграция подключена к странице «Читальня»?'), { code: 'no_sections' });

  // книга → самая свежая страница; остальные считаем дублями
  const byBook = new Map(); const unmatched = [];
  for (const p of pages) {
    const bookId = state.bindings[p.id] || matchBook(p.title, books);
    if (!bookId) { unmatched.push(p); continue; }
    const cur = byBook.get(bookId);
    if (!cur || p.edited > cur.edited) { if (cur) result.duplicates.push(cur.title); byBook.set(bookId, { ...p, bookId }); }
    else result.duplicates.push(p.title);
  }

  const fetchText = async p => cleanNote(await blocksToMarkdown(await notion.children(p.id), notion.children));
  for (const p of byBook.values()) {
    try {
      const prev = state.pages[p.id];
      const hasNote = !!store.get(['notes', p.bookId]).value;
      if (prev && prev.edited === p.edited && prev.bookId === p.bookId && hasNote) { result.unchanged++; result.matched++; continue; }
      const content = await fetchText(p);
      store.set(['notes', p.bookId], { content, updatedAt: p.edited.slice(0, 10), source: 'notion', pageId: p.id });
      state.pages[p.id] = { edited: p.edited, bookId: p.bookId, title: p.title };
      delete inbox[p.id];
      result.updated++; result.matched++;
    } catch (e) { result.errors.push(`${p.title}: ${e.message}`); }
  }
  for (const p of unmatched) {
    try {
      if (!(inbox[p.id] && inbox[p.id].edited === p.edited)) {
        inbox[p.id] = { pageId: p.id, title: p.title, edited: p.edited, section: p.section, content: await fetchText(p) };
      }
      result.inbox++;
    } catch (e) { result.errors.push(`${p.title}: ${e.message}`); }
  }
  for (const id of Object.keys(inbox)) if (!pages.some(p => p.id === id)) delete inbox[id]; // страницу убрали из Notion

  state.lastRun = now().toISOString(); state.lastResult = result;
  store.set(['notionState'], state);
  store.set(['notionInbox'], Object.keys(inbox).length ? inbox : null);
  return result;
}

/** Организатор разбирает страницу из «inbox»: привязать к существующей книге или создать новую. */
export function bindPage({ store, pageId, bookId, create }) {
  const inbox = store.get(['notionInbox']).value || {};
  const item = inbox[pageId];
  if (!item) throw Object.assign(new Error('Страница не найдена в списке'), { status: 404 });
  const state = store.get(['notionState']).value || { pages: {}, bindings: {} };
  state.pages ||= {}; state.bindings ||= {};
  let id = bookId;
  if (create) {
    id = 'n' + Date.now().toString(36);
    const g = guessBook(item.title);
    store.set(['books', id], {
      id, title: String(create.title || g.title).slice(0, 200), author: String(create.author ?? g.author).slice(0, 120),
      yearPublished: null, readingMonth: create.readingMonth || '', emoji: '📖', coverUrl: '', audioUrl: '', bookUrl: '', description: '',
    });
  } else if (!store.get(['books', bookId]).value) throw Object.assign(new Error('Такой книги нет'), { status: 400 });
  store.set(['notes', id], { content: item.content, updatedAt: item.edited.slice(0, 10), source: 'notion', pageId });
  state.bindings[pageId] = id;
  state.pages[pageId] = { edited: item.edited, bookId: id, title: item.title };
  delete inbox[pageId];
  store.set(['notionState'], state);
  store.set(['notionInbox'], Object.keys(inbox).length ? inbox : null);
  return id;
}
