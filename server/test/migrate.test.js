import test from 'node:test';
import assert from 'node:assert/strict';
import { convertFirebase } from '../src/migrate.js';

test('миграция: ленты из объектов в списки, личные данные — по карте имён, лишнее отбрасывается', () => {
  const out = convertFirebase({
    books: { b1: { id: 'b1', title: 'A' } },
    comments: { b1: { '-Kx1': { id: 'c1', text: 'hi', by: 'Анна' }, '-Kx2': { id: 'c2', text: 'yo', by: 'Мария' } } },
    ratings: { b1: { 'Анна': 5, 'Неизвестная': 1 } },
    userdata: { 'Анна': { progress: { b1: 40 } }, 'Неизвестная': { progress: {} } },
    members: { m1: { name: 'Анна' } },
    notes: { b1: { content: '\\nТекст\\n', updatedAt: 'd' } },
    config: { proCode: 'X' },
  }, { 'Анна': 111 });
  assert.equal(out.comments.b1.length, 2);
  assert.deepEqual(out.ratings, { b1: { u111: 5 } });
  assert.deepEqual(Object.keys(out.userdata), ['u111']);
  assert.equal(out.members, undefined);
  assert.equal(out.notes.b1.content, 'Текст');
  assert.equal(out.config.proCode, 'X');
});
