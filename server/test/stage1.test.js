import test from 'node:test';
import assert from 'node:assert/strict';
import { previewOf } from '../src/notes-preview.js';
import { openStore } from '../src/store.js';
import { createApp } from '../src/app.js';

test('превью конспекта: оглавление и только первый раздел', () => {
  const note = '# Часть 1\nПервый раздел открыт.\n## Тема\nещё\n# Часть 2\nСЕКРЕТНЫЙ ТЕКСТ';
  const p = previewOf(note);
  assert.equal(p.locked, true);
  assert.equal(p.sections, 3);
  assert.deepEqual(p.toc.map(t => t.title), ['Часть 1', 'Тема', 'Часть 2']);
  assert.ok(p.preview.includes('Первый раздел'));
  assert.ok(!JSON.stringify(p).includes('СЕКРЕТНЫЙ'));
});

test('превью обрезается по длине', () => {
  const p = previewOf('# A\n' + 'слово '.repeat(2000) + '\n# B\nскрыто');
  assert.ok(p.preview.length <= 2600);
  assert.ok(!p.preview.includes('скрыто'));
});

async function boot() {
  const store = openStore(':memory:');
  const app = createApp({ store, config: { botToken: 'x', adminIds: [1], devAuth: true } });
  const server = app.server();
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (as, method, path, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: as }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
  return { call, close: () => { server.close(); store.close(); } };
}

test('аватар: по умолчанию сова, меняется, неизвестный отклоняется, виден другим', async () => {
  const s = await boot();
  assert.equal((await s.call('dev 2|Anna', 'GET', '/api/me')).data.avatar, 'owl');
  assert.equal((await s.call('dev 2|Anna', 'POST', '/api/profile', { avatar: 'kitten' })).data.avatar, 'kitten');
  assert.equal((await s.call('dev 2|Anna', 'POST', '/api/profile', { avatar: '<script>' })).status, 400);
  const members = (await s.call('dev 3|Bob', 'POST', '/api/sync', {})).data.roots.members.value;
  assert.equal(members.find(m => m.name === 'Anna').avatar, 'kitten');
  // имя можно менять отдельно от аватара
  assert.equal((await s.call('dev 2|Anna', 'POST', '/api/profile', { name: 'Anya' })).data.avatar, 'kitten');
  s.close();
});

test('цели и даты прочтения — личные данные участницы', async () => {
  const s = await boot();
  assert.equal((await s.call('dev 2|Anna', 'PUT', '/api/db/userdata/u2/goals', { value: { 2026: 24 } })).status, 200);
  assert.equal((await s.call('dev 2|Anna', 'PUT', '/api/db/userdata/u2/finished', { value: { b1: '2026-03-01' } })).status, 200);
  assert.equal((await s.call('dev 3|Bob', 'GET', '/api/db/userdata/u2/goals')).status, 403);
  s.close();
});
