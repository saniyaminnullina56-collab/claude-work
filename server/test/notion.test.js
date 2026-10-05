import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksToMarkdown, matchBook, guessBook, syncNotion, bindPage, createNotion } from '../src/notion.js';
import { openStore } from '../src/store.js';
import { createApp } from '../src/app.js';

const rt = (text, bold = false) => [{ plain_text: text, annotations: { bold } }];
const blk = (id, type, text, extra = {}) => ({ id, type, has_children: !!extra.kids, last_edited_time: extra.edited, [type]: { rich_text: rt(text, extra.bold), ...(extra.d || {}) } });
const page = (id, title, edited) => ({ id, type: 'child_page', last_edited_time: edited, child_page: { title } });

// Подставной Notion: дерево блоков в памяти
function fakeNotion(tree) {
  const calls = [];
  const edited = id => { for (const kids of Object.values(tree)) { const f = kids.find(k => k.id === id); if (f) return f.last_edited_time; } };
  return { calls, children: async id => { calls.push(id); return tree[id] || []; }, page: async id => ({ last_edited_time: edited(id) }) };
}

const BOOKS = {
  b4: { id: 'b4', title: 'Сила воли', author: 'Келли Макгонигал' },
  b5: { id: 'b5', title: 'Выбор', author: 'Эдит Эгер' },
  b8: { id: 'b8', title: 'Унесённые ветром', author: 'Маргарет Митчелл' },
  b9: { id: 'b9', title: 'Дары волхвов', author: 'О. Генри' },
  p1: { id: 'p1', title: 'Личная', personal: true },
};

test('blocksToMarkdown: заголовки, списки, цитаты, callout, toggle, вложенность', async () => {
  const tree = { c1: [blk('x', 'paragraph', 'внутри')], t1: [blk('y', 'paragraph', 'скрытый текст')] };
  const md = await blocksToMarkdown([
    blk('1', 'heading_1', 'Часть 1'), blk('2', 'paragraph', 'Текст ', { bold: false }),
    blk('3', 'bulleted_list_item', 'пункт'), blk('4', 'numbered_list_item', 'один'), blk('5', 'numbered_list_item', 'два'),
    blk('6', 'quote', 'цитата'), blk('7', 'callout', 'важно', { kids: true, d: { icon: { emoji: '📌' } }, id: 'c1' }),
    blk('8', 'toggle', 'Вопрос', { kids: true }), { id: 'd', type: 'divider', divider: {} }, { id: 'img', type: 'image', image: {} },
  ].map((b, i) => (b.id === '7' ? { ...b, id: 'c1' } : b.id === '8' ? { ...b, id: 't1' } : b)), async id => tree[id] || []);
  assert.equal(md, ['# Часть 1', 'Текст', '- пункт', '1. один', '2. два', '> цитата', '<callout icon="📌">\nважно\nвнутри\n</callout>', '**Вопрос**', 'скрытый текст', '---'].join('\n'));
});

test('matchBook: реальные названия страниц из Notion находят нужные книги', () => {
  const books = Object.values(BOOKS).filter(b => !b.personal);
  const cases = {
    '“Сила воли” Келли Макгонигал': 'b4',
    'Выбор_Эдит Ева Эгер_ кк_февраль': 'b5',
    '“Унесенные ветром” Маргарет Митчелл': 'b8', // е вместо ё
    'Дары волхвов_ О.Генри': 'b9',
    '«Мастер и Маргарита» Михаил Булгаков': null, // книги нет в каталоге
  };
  for (const [title, want] of Object.entries(cases)) assert.equal(matchBook(title, books), want, title);
});

test('guessBook: название и автор из заголовка страницы', () => {
  assert.deepEqual(guessBook('«Нетерпение сердца» _ Стефан Цвейг'), { title: 'Нетерпение сердца', author: 'Стефан Цвейг' });
  assert.deepEqual(guessBook('Эрих Фромм _«Искусство любить» '), { title: 'Искусство любить', author: 'Эрих Фромм' });
  assert.deepEqual(guessBook('Человек-комбини'), { title: 'Человек-комбини', author: '' });
});

function setupSync() {
  const store = openStore(':memory:');
  store.set(['books'], BOOKS);
  const tree = {
    root: [page('s25', 'Конспекты по прочитанным книгам 2025', 't'), page('x', 'Reading List 2025', 't'), page('s26', 'Конспекты по прочитанным книгам 2026', 't')],
    s25: [page('pg1', '“Сила воли” Келли Макгонигал', '2026-09-06T16:48:00Z'), page('pg2', 'Дары волхвов_ О.Генри', '2025-02-17T06:48:00Z'), page('pg3', 'Дары волхвов _ О. Генри', '2025-12-01T10:00:00Z')],
    s26: [page('pg4', '«Прислуга»_Кэтрин Стокетт', '2026-03-01T10:00:00Z')],
    pg1: [blk('a', 'heading_1', 'Тема 1'), blk('b', 'paragraph', 'Про силу воли')],
    pg2: [blk('c', 'paragraph', 'старая версия')], pg3: [blk('d', 'paragraph', 'новая версия')],
    pg4: [blk('e', 'paragraph', 'Про Скаут')],
  };
  const notion = fakeNotion(tree);
  return { store, tree, notion, run: () => syncNotion({ store, notion, rootPageId: 'root', now: () => new Date('2026-10-05T00:00:00Z') }) };
}

test('синхронизация: сопоставляет, берёт свежий дубль, без книги — в список организатора', async () => {
  const s = setupSync();
  const r = await s.run();
  assert.equal(r.matched, 2); assert.equal(r.updated, 2); assert.equal(r.inbox, 1); assert.equal(r.errors.length, 0);
  assert.deepEqual(r.duplicates, ['Дары волхвов_ О.Генри']);
  assert.match(s.store.get(['notes', 'b4']).value.content, /Про силу воли/);
  assert.equal(s.store.get(['notes', 'b9']).value.content, 'новая версия');
  assert.equal(s.store.get(['notes', 'b4']).value.source, 'notion');
  const inbox = Object.values(s.store.get(['notionInbox']).value);
  assert.equal(inbox.length, 1); assert.equal(inbox[0].title, '«Прислуга»_Кэтрин Стокетт');
});

test('синхронизация: повторный запуск без правок ничего не скачивает; правка в Notion обновляет', async () => {
  const s = setupSync();
  await s.run();
  s.notion.calls.length = 0;
  const r2 = await s.run();
  assert.equal(r2.updated, 0); assert.equal(r2.unchanged, 2);
  assert.ok(!s.notion.calls.includes('pg1'), 'текст страницы повторно не запрашивался');
  s.tree.s25[0] = page('pg1', '“Сила воли” Келли Макгонигал', '2026-10-01T00:00:00Z');
  s.tree.pg1 = [blk('a', 'paragraph', 'Обновлённый конспект')];
  const r3 = await s.run();
  assert.equal(r3.updated, 1);
  assert.equal(s.store.get(['notes', 'b4']).value.content, 'Обновлённый конспект');
});

test('список «без книги»: привязать к существующей и создать новую книгу', async () => {
  const s = setupSync();
  s.tree.s26.push(page('pg5', 'Человек-комбини', '2026-04-01T00:00:00Z'));
  s.tree.pg5 = [blk('f', 'paragraph', 'Про Кэйко')];
  await s.run();
  const id = bindPage({ store: s.store, pageId: 'pg4', create: {} });
  assert.deepEqual(s.store.get(['books', id]).value.title, 'Прислуга');
  assert.equal(s.store.get(['books', id]).value.author, 'Кэтрин Стокетт');
  assert.match(s.store.get(['notes', id]).value.content, /Про Скаут/);
  assert.throws(() => bindPage({ store: s.store, pageId: 'pg5', bookId: 'нет-такой' }), /нет/);
  // привязка запоминается: после повторной синхронизации страница остаётся у своей книги и не возвращается в список
  const r = await s.run();
  assert.equal(r.inbox, 1); // осталась только «Человек-комбини»
  assert.equal(s.store.get(['notes', id]).value.pageId, 'pg4');
});

test('синхронизация: если интеграция не видит страниц — понятная ошибка', async () => {
  const store = openStore(':memory:');
  await assert.rejects(syncNotion({ store, notion: fakeNotion({ root: [] }), rootPageId: 'root' }), /Читальня/);
});

test('клиент Notion: повтор при 429 и разбор ошибок', async () => {
  let n = 0; const waits = [];
  const fetchImpl = async () => (++n === 1
    ? { status: 429, ok: false, headers: { get: () => '1' }, json: async () => ({}) }
    : { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ results: [], has_more: false }) });
  const c = createNotion({ token: 't', fetchImpl, sleep: async ms => waits.push(ms) });
  assert.deepEqual(await c.children('x'), []);
  assert.ok(waits.includes(1000));
  const bad = createNotion({ token: 't', sleep: async () => {}, fetchImpl: async () => ({ status: 404, ok: false, headers: { get: () => null }, json: async () => ({ message: 'not found', code: 'object_not_found' }) }) });
  await assert.rejects(bad.children('x'), e => e.status === 404 && e.code === 'object_not_found');
});

test('API организатора: статус, ручной запуск, привязка; участнице — 403', async () => {
  const s = setupSync();
  const app = createApp({ store: s.store, config: { botToken: 'x', adminIds: [1], devAuth: true }, notionClient: s.notion });
  app.notion.rootForTest = true;
  const server = app.server(); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (as, method, path, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: as }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
  assert.equal((await call('dev 2|Anna', 'GET', '/api/admin/notion')).status, 403);
  assert.equal((await call('dev 2|Anna', 'GET', '/api/db/notionInbox')).status, 403, 'служебные корни не читаются через общий API');
  assert.equal((await call('dev 2|Anna', 'GET', '/api/db/notionState')).status, 403);
  await s.run();
  const st = (await call('dev 1|Admin', 'GET', '/api/admin/notion')).data;
  assert.equal(st.configured, true); assert.equal(st.inbox.length, 1); assert.equal(st.lastResult.updated, 2);
  const bound = await call('dev 1|Admin', 'POST', '/api/admin/notion/bind', { pageId: 'pg4', create: {} });
  assert.equal(bound.status, 200);
  assert.equal((await call('dev 1|Admin', 'POST', '/api/admin/notion/bind', { pageId: 'нет' })).status, 404);
  server.close(); s.store.close();
});

test('понятные подсказки при неверном токене и неподключённой странице', async () => {
  for (const [status, re] of [[401, /не принял токен/], [404, /Подключения/]]) {
    const store = openStore(':memory:');
    const notionClient = { children: async () => { throw Object.assign(new Error('x'), { status }); } };
    const app = createApp({ store, config: { botToken: 'x', adminIds: [1], devAuth: true, notionRootPageId: 'root' }, notionClient });
    await assert.rejects(app.runNotionSync());
    assert.match(store.get(['notionState']).value.lastError.message, re);
    store.close();
  }
});
