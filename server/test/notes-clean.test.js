import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNote } from '../src/notes-clean.js';

test('cleanNote: раскрывает двойное экранирование и убирает теги Notion', () => {
  const raw = '\\n# Часть 1\\n<callout icon=\\"📌\\" color=\\"gray_bg\\">\\n\\tТекст\\n</callout>\\n<empty-block/>\\n<details><summary>Вопрос</summary>Ответ</details>';
  const out = cleanNote(raw);
  assert.ok(out.includes('# Часть 1\n<callout icon="📌" color="gray_bg">\nТекст\n</callout>'));
  assert.ok(!out.includes('\\n') && !out.includes('empty-block') && !out.includes('<details'));
  assert.ok(out.includes('**Вопрос**'));
});
test('cleanNote: нормальный текст не портит', () => {
  assert.equal(cleanNote('Обычный\nтекст с \\ слэшем'), 'Обычный\nтекст с \\ слэшем');
});
