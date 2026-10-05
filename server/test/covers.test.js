import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scoreCandidate, findCovers, isAllowedCoverUrl } from '../src/covers.js';
import { openStore } from '../src/store.js';
import { createApp } from '../src/app.js';

const book = { id: 'b4', title: 'Сила воли', author: 'Келли Макгонигал' };
const cand = (o) => ({ title: 'Сила воли', subtitle: '', authors: ['Келли Макгонигал'], lang: 'ru', ...o });

test('оценка: автоматически — только название + автор + язык; всё остальное вручную', () => {
  assert.equal(scoreCandidate(book, cand({})).confidence, 'high');
  assert.equal(scoreCandidate(book, cand({ authors: ['Другой Автор'] })).confidence, 'medium', 'то же название, другой автор');
  assert.equal(scoreCandidate(book, cand({ title: 'The Willpower Instinct', authors: ['Kelly McGonigal'], lang: 'en' })).confidence, 'low', 'другое издание на другом языке');
  assert.equal(scoreCandidate(book, cand({ title: 'Сила воли. Рабочая тетрадь' })).confidence, 'low', 'лишние слова — другая книга');
  assert.equal(scoreCandidate(book, cand({ lang: 'en' })).confidence, 'low', 'русская книга, английское издание');
  // регистр, «ё», кавычки не мешают; подзаголовок засчитывается
  const b2 = { id: 'x', title: 'Унесённые ветром', author: 'Маргарет Митчелл' };
  assert.equal(scoreCandidate(b2, { title: '«УНЕСЕННЫЕ ветром»', authors: ['Маргарет Митчелл'], lang: 'ru' }).confidence, 'high');
  const b3 = { id: 'y', title: 'Эссенциализм. Путь к простоте', author: 'Грег МакКеон' };
  assert.equal(scoreCandidate(b3, { title: 'Эссенциализм', subtitle: 'Путь к простоте', authors: ['Грег МакКеон'], lang: 'ru' }).confidence, 'high');
  const b4 = { id: 'z', title: 'Выбор', author: 'Эдит Эгер' };
  assert.equal(scoreCandidate(b4, { title: 'Выбор профессии', authors: ['Кто-то Другой'], lang: 'ru' }).confidence, 'low', 'часть названия другой книги');
});

test('источники: Google Books и Open Library, ошибка одного не ломает остальное', async () => {
  const google = { items: [
    { id: 'G1', volumeInfo: { title: 'Сила воли', authors: ['Келли Макгонигал'], language: 'ru', imageLinks: { thumbnail: 'http://x' } } },
    { id: 'G2', volumeInfo: { title: 'Сила воли. Рабочая тетрадь', authors: ['Келли Макгонигал'], language: 'ru', imageLinks: { thumbnail: 'http://y' } } },
    { id: 'G3', volumeInfo: { title: 'Сила воли', authors: ['Келли Макгонигал'], language: 'ru' } }, // без картинки
  ] };
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return url.includes('googleapis') ? { ok: true, json: async () => google } : { ok: false, status: 503, json: async () => ({}) }; };
  const r = await findCovers(book, { fetchImpl });
  assert.equal(r.candidates[0].confidence, 'high');
  assert.equal(r.candidates[0].url, 'https://books.google.com/books/content?id=G1&printsec=frontcover&img=1&zoom=1');
  assert.ok(!r.candidates.some(c => c.url.includes('G3')), 'без картинки не берём');
  assert.equal(r.errors.length, 1); assert.match(r.errors[0], /Open Library/);
  assert.ok(urls[0].includes('langRestrict=ru'));
});

test('адрес обложки: только https и известные хосты', () => {
  assert.equal(isAllowedCoverUrl('https://covers.openlibrary.org/b/id/1-L.jpg'), true);
  assert.equal(isAllowedCoverUrl('https://books.google.com/books/content?id=1'), true);
  for (const u of ['http://covers.openlibrary.org/x', 'https://evil.example/x.jpg', 'javascript:alert(1)', '', null]) assert.equal(isAllowedCoverUrl(u), false, String(u));
});

async function boot(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'covers-'));
  const store = openStore(':memory:');
  store.set(['books'], { b4: book, b5: { id: 'b5', title: 'Выбор', author: 'Эдит Эгер' }, b6: { id: 'b6', title: 'Невидимые женщины', author: 'Кэролайн Криадо Перес', coverUrl: 'https://covers.openlibrary.org/b/id/9-L.jpg' } });
  const app = createApp({ store, config: { botToken: 'x', adminIds: [1], devAuth: true, coversDir: dir, priceAll: '2500 ₸' }, fetchImpl, sleep: async () => {} });
  const server = app.server(); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (as, method, path_, body, raw) => fetch(base + path_, { method, headers: { authorization: as, ...(raw ? { 'content-type': 'image/png' } : { 'content-type': 'application/json' }) }, body: raw || (body === undefined ? undefined : JSON.stringify(body)) }).then(async r => ({ status: r.status, data: await r.json().catch(() => null), res: r }));
  return { store, app, call, base, dir, close: () => { server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test('автоподбор: уверенное совпадение ставится само, сомнительное — в список на проверку, с обложкой не трогаем', async () => {
  const fetchImpl = async url => {
    const q = decodeURIComponent(url);
    if (!url.includes('googleapis')) return { ok: true, json: async () => ({ docs: [] }) };
    if (q.includes('Сила воли')) return { ok: true, json: async () => ({ items: [{ id: 'G1', volumeInfo: { title: 'Сила воли', authors: ['Келли Макгонигал'], language: 'ru', imageLinks: { thumbnail: 't' } } }] }) };
    return { ok: true, json: async () => ({ items: [{ id: 'G9', volumeInfo: { title: 'Выбор', authors: ['Не Тот Автор'], language: 'ru', imageLinks: { thumbnail: 't' } } }] }) };
  };
  const s = await boot(fetchImpl);
  const r = await s.app.runCoverJob();
  assert.equal(r.applied, 1); assert.equal(r.review, 1);
  assert.match(s.store.get(['books', 'b4']).value.coverUrl, /id=G1/);
  assert.equal(s.store.get(['books', 'b5']).value.coverUrl, undefined, 'при другом авторе сами не ставим');
  assert.equal(s.store.get(['books', 'b6']).value.coverUrl, 'https://covers.openlibrary.org/b/id/9-L.jpg', 'готовую обложку не трогаем');
  const st = (await s.call('dev 1|A', 'GET', '/api/admin/covers')).data;
  assert.equal(st.review.b5[0].confidence, 'medium'); assert.deepEqual(st.missing.map(m => m.id), ['b5']);
  s.close();
});

test('вручную: выбор кандидата, допустимые адреса, загрузка файла, права', async () => {
  const s = await boot(async () => ({ ok: true, json: async () => ({ items: [], docs: [] }) }));
  assert.equal((await s.call('dev 2|U', 'POST', '/api/admin/covers/apply', { bookId: 'b5', url: 'https://covers.openlibrary.org/b/id/1-L.jpg' })).status, 403);
  assert.equal((await s.call('dev 1|A', 'POST', '/api/admin/covers/apply', { bookId: 'b5', url: 'https://evil.example/a.jpg' })).status, 400);
  assert.equal((await s.call('dev 1|A', 'POST', '/api/admin/covers/apply', { bookId: 'b5', url: 'https://covers.openlibrary.org/b/id/1-L.jpg' })).status, 200);
  assert.equal(s.store.get(['books', 'b5']).value.coverSource, 'manual');
  // загрузка своей обложки
  assert.equal((await s.call('dev 2|U', 'PUT', '/api/admin/covers/b5', undefined, PNG)).status, 403);
  assert.equal((await s.call('dev 1|A', 'PUT', '/api/admin/covers/b5', undefined, Buffer.from('<?php evil ?>'))).status, 400, 'не картинка');
  assert.equal((await s.call('dev 1|A', 'PUT', '/api/admin/covers/b5', undefined, PNG)).status, 200);
  const url = s.store.get(['books', 'b5']).value.coverUrl;
  assert.match(url, /^\/covers\/b5\.png\?v=/);
  const img = await fetch(s.base + url);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(s.base + '/covers/..%2fpackage.json')).status, 404);
  assert.equal((await fetch(s.base + '/covers/nope.png')).status, 404);
  assert.equal((await s.call('dev 1|A', 'PUT', '/api/admin/covers/nobook', undefined, PNG)).status, 404);
  assert.equal((await s.call('dev 1|A', 'DELETE', '/api/admin/covers/b5')).status, 200);
  assert.equal(s.store.get(['books', 'b5']).value.coverUrl, '');
  s.close();
});

test('цена «Все конспекты» по умолчанию 2500 ₸; организатор может изменить', async () => {
  const s = await boot(async () => ({ ok: true, json: async () => ({}) }));
  assert.equal((await s.call('dev 2|U', 'GET', '/api/db/config')).data.value.payInfo.price, '2500 ₸');
  await s.call('dev 1|A', 'PUT', '/api/db/config/payInfo', { value: { price: '3000 ₸' } });
  assert.equal((await s.call('dev 2|U', 'GET', '/api/db/config')).data.value.payInfo.price, '3000 ₸');
  s.close();
});
