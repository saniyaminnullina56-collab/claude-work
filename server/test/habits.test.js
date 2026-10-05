import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkWrite } from '../src/rules.js';

const m = { exports: {} };
new Function('module', fs.readFileSync(new URL('../public/habits.js', import.meta.url), 'utf8'))(m);
const H = m.exports;

const T = '2026-10-07'; // среда
const habit = (o = {}) => ({ id: 'h1', name: 'Читать 20 минут', emoji: '📖', days: null, createdAt: '2026-09-01', ...o });
const logOf = (days, id = 'h1') => Object.fromEntries(days.map(d => [d, [id]]));
const back = n => H.addDays(T, -n);

test('состояние аватара растёт с выполнением привычек', () => {
  const h = [habit()];
  assert.equal(H.mood(h, {}, T).mood, 'sleepy', 'ничего не выполнено за неделю');
  assert.equal(H.mood(h, logOf([back(1), back(2), back(3)]), T).mood, 'ok');           // 3 из 6 прошедших дней = 50%
  assert.equal(H.mood(h, logOf([T, back(1), back(2), back(3), back(4)]), T).mood, 'happy'); // 5 из 6
  assert.equal(H.mood(h, logOf([T, 1, 2, 3, 4, 5, 6].map(n => (n === T ? T : back(n)))), T).mood, 'glow');
  // монотонность: каждая новая отметка не ухудшает состояние
  const order = ['sleepy', 'ok', 'happy', 'glow'];
  let prev = -1, log = {};
  for (let i = 6; i >= 0; i--) { log = { ...log, [back(i)]: ['h1'] }; const cur = order.indexOf(H.mood(h, log, T).mood); assert.ok(cur >= prev); prev = cur; }
});

test('справедливость: сегодня не наказывает, новая привычка не штрафуется, без привычек — нейтрально', () => {
  assert.equal(H.mood([habit()], logOf([back(1), back(2), back(3), back(4), back(5), back(6)]), T).mood, 'glow', 'сегодня ещё не выполнено — ничего страшного');
  const fresh = habit({ createdAt: T });
  assert.equal(H.mood([fresh], {}, T).mood, 'ok', 'создана сегодня — не «сонный»');
  assert.equal(H.mood([habit({ createdAt: back(1) })], logOf([T, back(1)]), T).mood, 'happy', 'меньше трёх дней опыта — максимум «бодрый»');
  assert.equal(H.mood([], {}, T).empty, true);
  assert.equal(H.mood([habit({ archivedAt: T })], {}, T).empty, true, 'архивные не считаются');
});

test('расписание по дням недели: непланируемые дни не штрафуют и серию не рвут', () => {
  const mwf = habit({ days: [1, 3, 5] }); // пн, ср, пт; T — среда
  assert.equal(H.isScheduled(mwf, T), true);
  assert.equal(H.isScheduled(mwf, back(1)), false); // вторник
  // выполнено ср (сегодня), пн (back 2), пт (back 5) — вторник и выходные пропускаются
  const log = logOf([T, back(2), back(5)]);
  assert.equal(H.streak(mwf, log, T), 3);
  assert.equal(H.streak(mwf, logOf([back(2), back(5)]), T), 2, 'сегодня не выполнено — серия сохраняется');
  assert.equal(H.streak(mwf, logOf([T, back(5)]), T), 1, 'пропущен понедельник — серия сбита');
});

test('серия ежедневной привычки и не уходит за дату создания', () => {
  const h = habit({ createdAt: back(3) });
  assert.equal(H.streak(h, logOf([T, back(1), back(2), back(3)]), T), 4);
  assert.equal(H.streak(h, logOf([T, back(1), back(2)]), T), 3);
  assert.equal(H.streak(h, {}, T), 0);
});

test('уровень: пороги и прогресс до следующего', () => {
  assert.equal(H.level(0).level, 1);
  assert.equal(H.level(4).level, 1);
  assert.equal(H.level(5).level, 2);
  assert.deepEqual([H.level(29).level, H.level(30).level], [3, 4]);
  const l = H.level(20); assert.equal(l.next, 30); assert.equal(l.into, 5); assert.equal(l.need, 15);
  assert.equal(H.level(9999).level, 10); assert.equal(H.level(9999).next, null);
  // чужие/удалённые идентификаторы в журнале не дают опыта
  assert.equal(H.totalDone([habit()], { [T]: ['h1', 'ghost'], [back(1)]: ['h1'] }), 2);
});

test('отметка: можно переключать сегодня и задним числом до 14 дней; будущее и древнее — нет', () => {
  let log = H.toggle({}, 'h1', T, T);
  assert.deepEqual(log[T], ['h1']);
  log = H.toggle(log, 'h1', T, T);
  assert.equal(T in log, false, 'повторное нажатие снимает отметку');
  assert.deepEqual(H.toggle({}, 'h1', H.addDays(T, 1), T), {}, 'в будущее нельзя');
  assert.deepEqual(H.toggle({}, 'h1', back(15), T), {}, 'старше 14 дней нельзя');
  assert.deepEqual(H.toggle({}, 'h1', back(14), T)[back(14)], ['h1']);
});

test('новая привычка: обрезка, очистка, дни недели', () => {
  assert.equal(H.newHabit({ name: '   ' }, T), null);
  const h = H.newHabit({ name: '  Пить   воду ' + 'я'.repeat(60), emoji: '💧', days: [5, 1, 1, 9, -1] }, T);
  assert.equal(h.name.length, 40); assert.deepEqual(h.days, [1, 5]); assert.equal(h.createdAt, T);
  assert.equal(H.newHabit({ name: 'Каждый день', days: [0, 1, 2, 3, 4, 5, 6] }, T).days, null, 'все семь дней = каждый день');
});

test('сетка трекера: 4 недели с понедельника, будущее пустое', () => {
  const g = H.grid(habit(), logOf([T]), T);
  assert.equal(g.length, 28);
  assert.equal(H.weekday(g[0].day), 1, 'начинается с понедельника');
  assert.equal(g.filter(c => c.today).length, 1);
  assert.ok(g.find(c => c.today).done);
  assert.ok(g.filter(c => c.future).every(c => c.day > T));
  assert.equal(H.monthRate(habit(), logOf([back(1), back(2)]), T), 7, '2 из 27 прошедших дней; сегодняшний невыполненный не считается');
});

test('сервер: привычки — личные данные участницы, формат проверяется', () => {
  const u = { id: 2, name: 'Анна', isAdmin: false, pro: false };
  const ok = [{ id: 'h1', name: 'Читать', emoji: '📖', days: null, createdAt: '2026-10-01' }];
  assert.equal(checkWrite(['userdata', 'u2', 'habits'], ok, null, u), null);
  assert.equal(checkWrite(['userdata', 'u3', 'habits'], ok, null, u), 'forbidden', 'чужие — нельзя');
  assert.ok(checkWrite(['userdata', 'u2', 'habits'], Array(21).fill(ok[0]), null, u), 'не больше 20 активных привычек');
  assert.equal(checkWrite(['userdata', 'u2', 'habits'], [...Array(20).fill(ok[0]), ...Array(30).fill({ ...ok[0], archivedAt: '2026-10-02' })], null, u), null, 'архивные не мешают');
  assert.ok(checkWrite(['userdata', 'u2', 'habits'], Array(61).fill({ ...ok[0], archivedAt: '2026-10-02' }), null, u), 'но и бесконечно копиться не должны');
  assert.ok(checkWrite(['userdata', 'u2', 'habits'], [{ ...ok[0], name: 'x'.repeat(100) }], null, u), 'длинное имя');
  assert.ok(checkWrite(['userdata', 'u2', 'habits'], 'не массив', null, u));
  assert.equal(checkWrite(['userdata', 'u2', 'habitlog'], { '2026-10-01': ['h1'] }, null, u), null);
  assert.ok(checkWrite(['userdata', 'u2', 'habitlog'], { 'вчера': ['h1'] }, null, u), 'неверная дата');
  assert.ok(checkWrite(['userdata', 'u2', 'habitlog'], { '2026-10-01': 'h1' }, null, u), 'значение не список');
});
