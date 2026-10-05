import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { verifyInitData, signInitData } from '../src/telegram.js';

const TOKEN = '123456:TEST-TOKEN';
async function setup(extra = {}) {
  const store = openStore(':memory:');
  const config = { botToken: TOKEN, adminIds: [1], devAuth: true, initDataMaxAgeSec: 3600, publicUrl: 'https://club.test', webhookSecret: 'sek', ...extra };
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, result: {} }) }; };
  const app = createApp({ store, config, fetchImpl, sleep: async () => {} });
  const server = app.server();
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (as, method, path, body, headers = {}) => fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(as ? { authorization: as.replace(/\|(.*)$/, (_, n) => '|' + encodeURIComponent(n)) } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
  return { store, base, call, sent, close: () => { server.close(); store.close(); } };
}
const admin = 'dev 1|Сания', ann = 'dev 2|Анна', bob = 'dev 3|Боб';

test('initData: верная подпись принимается, подделка и устаревшее — нет', () => {
  const now = Math.floor(Date.now() / 1000);
  const f = { auth_date: String(now), user: JSON.stringify({ id: 42, first_name: 'Аня' }), query_id: 'q' };
  const good = signInitData(f, TOKEN);
  assert.equal(verifyInitData(good, TOKEN, 3600).id, 42);
  assert.equal(verifyInitData(good, 'other:token', 3600), null);
  assert.equal(verifyInitData(good.replace('42', '43'), TOKEN, 3600), null);
  const old = signInitData({ ...f, auth_date: String(now - 7200) }, TOKEN);
  assert.equal(verifyInitData(old, TOKEN, 3600), null);
  assert.equal(verifyInitData('', TOKEN), null);
});

test('без авторизации доступа нет; в production dev-вход отключён', async () => {
  const s = await setup();
  assert.equal((await s.call(null, 'GET', '/api/me')).status, 401);
  assert.equal((await s.call('dev 0|x', 'GET', '/api/me')).status, 401);
  s.close();
  const p = await setup({ devAuth: false });
  assert.equal((await p.call(admin, 'GET', '/api/me')).status, 401);
  p.close();
});

test('админом нельзя стать самому: только по ADMIN_IDS', async () => {
  const s = await setup();
  assert.equal((await s.call(admin, 'GET', '/api/me')).data.isAdmin, true);
  assert.equal((await s.call(ann, 'GET', '/api/me')).data.isAdmin, false);
  assert.equal((await s.call(ann, 'PUT', '/api/db/books/b1', { value: { id: 'b1', title: 'x' } })).status, 403);
  assert.equal((await s.call(ann, 'PUT', '/api/db/config/proCode', { value: 'HACK' })).status, 403);
  assert.equal((await s.call(ann, 'POST', '/api/db/announcements', { value: { text: 'hi' } })).status, 403);
  assert.equal((await s.call(admin, 'PUT', '/api/db/books/b1', { value: { id: 'b1', title: 'Книга' } })).status, 200);
  assert.equal((await s.call(ann, 'GET', '/api/db/books/b1')).data.value.title, 'Книга');
  s.close();
});

test('коды доступа не утекают участницам, админ их видит', async () => {
  const s = await setup();
  await s.call(admin, 'PUT', '/api/db/config', { value: { proCode: 'SECRET', payInfo: { price: '5000' }, bookPayInfo: { b1: { price: '1000', code: 'BOOKCODE' } } } });
  const c = (await s.call(ann, 'GET', '/api/db/config')).data.value;
  assert.equal(c.proCode, undefined);
  assert.equal(c.bookPayInfo.b1.code, undefined);
  assert.equal(c.bookPayInfo.b1.price, '1000');
  assert.equal((await s.call(ann, 'GET', '/api/db/config/proCode')).data.value, null);
  const sync = (await s.call(ann, 'POST', '/api/sync', {})).data.roots.config.value;
  assert.equal(JSON.stringify(sync).includes('SECRET'), false);
  assert.equal(JSON.stringify(sync).includes('BOOKCODE'), false);
  assert.equal((await s.call(admin, 'GET', '/api/db/config')).data.value.proCode, 'SECRET');
  s.close();
});

test('конспекты: без кода — заглушка, с верным кодом — текст; код перебором не подобрать', async () => {
  const s = await setup();
  await s.call(admin, 'PUT', '/api/notes/b1', { content: 'ПЛАТНЫЙ ТЕКСТ' });
  await s.call(admin, 'PUT', '/api/notes/b2', { content: 'ВТОРОЙ' });
  await s.call(admin, 'PUT', '/api/db/config', { value: { proCode: 'ALL', bookPayInfo: { b1: { code: 'ONE' } } } });
  assert.equal((await s.call(ann, 'GET', '/api/db/notes')).status, 403);
  let notes = (await s.call(ann, 'GET', '/api/notes')).data;
  assert.deepEqual(notes.b1, { locked: true });
  assert.equal(JSON.stringify(notes).includes('ПЛАТНЫЙ'), false);
  assert.equal((await s.call(ann, 'POST', '/api/redeem', { code: 'wrong', bookId: 'b1' })).status, 403);
  assert.equal((await s.call(ann, 'POST', '/api/redeem', { code: 'one', bookId: 'b1' })).data.scope, 'b1');
  notes = (await s.call(ann, 'GET', '/api/notes')).data;
  assert.equal(notes.b1.content, 'ПЛАТНЫЙ ТЕКСТ');
  assert.deepEqual(notes.b2, { locked: true });
  assert.equal((await s.call(bob, 'POST', '/api/redeem', { code: 'all' })).data.scope, '*');
  assert.equal((await s.call(bob, 'GET', '/api/notes')).data.b2.content, 'ВТОРОЙ');
  assert.equal((await s.call(ann, 'PUT', '/api/notes/b1', { content: 'x' })).status, 403);
  // перебор: после 8 попыток — 429
  let last;
  for (let i = 0; i < 10; i++) last = await s.call('dev 9|Злоумышленник', 'POST', '/api/redeem', { code: 'g' + i });
  assert.equal(last.status, 429);
  s.close();
});

test('лента: чужое удалять/править нельзя, реакции и свои записи — можно', async () => {
  const s = await setup();
  const c = { id: 'c1', text: 'привет', by: 'Анна', date: 'd', reactions: {}, replies: [] };
  assert.equal((await s.call(ann, 'POST', '/api/db/comments/b1', { value: c })).status, 200);
  assert.equal((await s.call(ann, 'POST', '/api/db/comments/b1', { value: { ...c, id: 'c2', by: 'Боб' } })).status, 403, 'подпись чужим именем');
  let list = (await s.call(bob, 'GET', '/api/db/comments/b1')).data.value;
  assert.equal(Array.isArray(list), true);
  assert.equal((await s.call(bob, 'PUT', '/api/db/comments/b1', { value: [] })).status, 403, 'удаление чужого');
  assert.equal((await s.call(bob, 'PUT', '/api/db/comments/b1', { value: [{ ...c, text: 'взломано' }] })).status, 403, 'правка чужого');
  assert.equal((await s.call(bob, 'PUT', '/api/db/comments/b1', { value: [{ ...c, reactions: { '❤️': ['Анна'] } }] })).status, 403, 'реакция от чужого имени');
  assert.equal((await s.call(bob, 'PUT', '/api/db/comments/b1', { value: [{ ...c, reactions: { '❤️': ['Боб'] } }] })).status, 200, 'своя реакция');
  const withReply = [{ ...c, reactions: { '❤️': ['Боб'] }, replies: [{ id: 'r1', text: 'ответ', by: 'Боб', reactions: {} }] }];
  assert.equal((await s.call(bob, 'PUT', '/api/db/comments/b1', { value: withReply })).status, 200, 'свой ответ');
  assert.equal((await s.call(ann, 'PUT', '/api/db/comments/b1', { value: [{ ...withReply[0], replies: [] }] })).status, 403, 'удаление чужого ответа');
  assert.equal((await s.call(admin, 'PUT', '/api/db/comments/b1', { value: [] })).status, 200, 'админ модерирует');
  s.close();
});

test('голосование и личные данные: только за себя', async () => {
  const s = await setup();
  const opt = { id: 'v1', title: 'Книга А', votes: [] };
  assert.equal((await s.call(ann, 'PUT', '/api/db/votes/options', { value: [opt] })).status, 200, 'предложить вариант');
  assert.equal((await s.call(bob, 'PUT', '/api/db/votes/options', { value: [{ ...opt, votes: ['Анна'] }] })).status, 403, 'голос за другого');
  assert.equal((await s.call(bob, 'PUT', '/api/db/votes/options', { value: [{ ...opt, votes: ['Боб'] }] })).status, 200);
  assert.equal((await s.call(bob, 'PUT', '/api/db/votes/options', { value: [] })).status, 403, 'удалить вариант');
  assert.equal((await s.call(ann, 'PUT', '/api/db/ratings/b1/u2', { value: 5 })).status, 200);
  assert.equal((await s.call(ann, 'PUT', '/api/db/ratings/b1/u3', { value: 1 })).status, 403, 'чужая оценка');
  assert.equal((await s.call(ann, 'PUT', '/api/db/userdata/u2/progress', { value: { b1: 10 } })).status, 200);
  assert.equal((await s.call(bob, 'GET', '/api/db/userdata/u2/progress')).status, 403);
  assert.equal((await s.call(bob, 'PUT', '/api/db/userdata/u2/progress', { value: {} })).status, 403);
  assert.equal((await s.call(admin, 'GET', '/api/db/userdata/u2/progress')).status, 403, 'даже админ не читает чужое');
  const sync = (await s.call(bob, 'POST', '/api/sync', {})).data.roots;
  assert.equal(JSON.stringify(sync.userdata.value).includes('"b1":10'), false, 'sync не отдаёт чужой userdata');
  s.close();
});

test('опасные пути и тела отклоняются', async () => {
  const s = await setup();
  for (const p of ['/api/db/__proto__/x', '/api/db/books/constructor', '/api/db/a/b/c/d/e/f/g']) {
    assert.equal((await s.call(admin, 'PUT', p, { value: 1 })).status, 400, p);
  }
  assert.equal((await s.call(ann, 'PUT', '/api/db/adaptations/b1', { value: 'x'.repeat(400_000) })).status, 413);
  assert.equal((await s.call(ann, 'PUT', '/api/db/members/x', { value: 1 })).status, 403);
  s.close();
});

test('профиль: имена уникальны, участницы видят список без лишнего', async () => {
  const s = await setup();
  await s.call(ann, 'GET', '/api/me');
  const dup = await s.call('dev 5|Анна', 'GET', '/api/me');
  assert.notEqual(dup.data.name, 'Анна');
  assert.equal((await s.call(bob, 'POST', '/api/profile', { name: 'анна' })).status, 409);
  const members = (await s.call(bob, 'GET', '/api/me') && await s.call(bob, 'POST', '/api/sync', {})).data.roots.members.value;
  assert.ok(members.every(m => Object.keys(m).sort().join() === 'id,isAdmin,name,role'));
  s.close();
});

test('бот: webhook только с секретом, /start даёт кнопку, рассылка уважает /stop', async () => {
  const s = await setup();
  const upd = { message: { chat: { id: 2, type: 'private' }, from: { id: 2, first_name: 'Анна' }, text: '/start' } };
  assert.equal((await s.call(null, 'POST', '/api/bot/webhook', upd)).status, 403);
  assert.equal((await s.call(null, 'POST', '/api/bot/webhook', upd, { 'x-telegram-bot-api-secret-token': 'sek' })).status, 200);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(s.sent.at(-1).body.reply_markup.inline_keyboard[0][0].web_app.url, 'https://club.test');
  await s.call(null, 'POST', '/api/bot/webhook', { message: { chat: { id: 3, type: 'private' }, from: { id: 3, first_name: 'Боб' }, text: '/stop' } }, { 'x-telegram-bot-api-secret-token': 'sek' });
  s.sent.length = 0;
  assert.equal((await s.call(ann, 'POST', '/api/admin/broadcast', { text: 'Новая книга' })).status, 403);
  assert.equal((await s.call(admin, 'POST', '/api/admin/broadcast', { text: 'Новая книга месяца', bookId: 'b9' })).status, 202);
  await new Promise(r => setTimeout(r, 100));
  const targets = s.sent.filter(m => m.body.text === 'Новая книга месяца').map(m => m.body.chat_id);
  assert.ok(targets.includes(2) && !targets.includes(3));
  s.close();
});

test('статика: CSP на странице, выход за пределы public закрыт', async () => {
  const s = await setup();
  const base = s.base;
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  for (const p of ['/..%2fsrc%2fapp.js', '/%2e%2e/src/app.js', '/..%2f..%2fpackage.json']) {
    const x = await fetch(base + p);
    assert.equal(x.status, 404, p);
  }
  s.close();
});

test('бесплатно: всё, кроме конспектов и личной библиотеки; платное закрыто и на сервере', async () => {
  const s = await setup();
  await s.call(admin, 'PUT', '/api/db/books', { value: { b1: { id: 'b1', title: 'Клубная' }, p1: { id: 'p1', title: 'Личная', personal: true } } });
  await s.call(admin, 'PUT', '/api/db/personalReviews/p1', { value: [{ by: 'Сания', text: 'отзыв' }] });
  await s.call(admin, 'PUT', '/api/db/config', { value: { proCode: 'ALL' } });
  // без оплаты: клубный каталог, обсуждения, голосование, оценки — доступны
  const books = (await s.call(ann, 'GET', '/api/db/books')).data.value;
  assert.deepEqual(Object.keys(books), ['b1']);
  assert.equal((await s.call(ann, 'POST', '/api/db/comments/b1', { value: { id: 'c1', text: 'hi', by: 'Анна' } })).status, 200);
  assert.equal((await s.call(ann, 'PUT', '/api/db/ratings/b1/u2', { value: 4 })).status, 200);
  // личная библиотека: чтение и запись закрыты
  assert.equal((await s.call(ann, 'GET', '/api/db/personalReviews/p1')).data.value, null);
  assert.equal((await s.call(ann, 'PUT', '/api/db/personalReviews/p1', { value: [{ by: 'Анна', text: 'x' }] })).status, 403);
  const roots = (await s.call(ann, 'POST', '/api/sync', {})).data.roots;
  assert.equal(JSON.stringify(roots.books.value).includes('Личная'), false);
  // после кода — открывается
  await s.call(ann, 'POST', '/api/redeem', { code: 'all' });
  assert.deepEqual(Object.keys((await s.call(ann, 'GET', '/api/db/books')).data.value).sort(), ['b1', 'p1']);
  assert.equal((await s.call(ann, 'PUT', '/api/db/personalReviews/p1', { value: [{ by: 'Сания', text: 'отзыв' }, { by: 'Анна', text: 'моё' }] })).status, 200);
  s.close();
});
