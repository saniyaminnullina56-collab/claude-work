// Привычки: расписание, серии, состояние аватара и уровень. Чистые функции: работают и в браузере, и в тестах.
// Даты — строки «ГГГГ-ММ-ДД» по местному времени участницы.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Habits = factory();
})(this, function () {
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const weekday = s => parse(s).getDay(); // 0 — воскресенье
  const MAX_BACKFILL = 14;   // отмечать задним числом можно за последние 14 дней
  const MAX_HABITS = 20;

  function isScheduled(h, day) {
    if (h.createdAt && day < h.createdAt) return false;
    if (h.archivedAt && day >= h.archivedAt) return false;
    return !h.days || !h.days.length || h.days.indexOf(weekday(day)) >= 0;
  }
  const doneOn = (log, h, day) => !!(log && log[day] && log[day].indexOf(h.id) >= 0);

  /** Серия: сколько расписанных дней подряд выполнено. Сегодняшний невыполненный день серию не рвёт. */
  function streak(h, log, today) {
    let n = 0, d = today;
    if (!doneOn(log, h, d)) d = addDays(d, -1);
    for (let i = 0; i < 400; i++) {
      if (h.createdAt && d < h.createdAt) break;
      if (!isScheduled(h, d)) { d = addDays(d, -1); continue; }
      if (!doneOn(log, h, d)) break;
      n++; d = addDays(d, -1);
    }
    return n;
  }

  /**
   * Состояние аватара по последним 7 дням: sleepy < 30% ≤ ok < 60% ≤ happy < 85% ≤ glow.
   * Сегодняшний день только добавляет: невыполненное сегодня не наказывается. Новая привычка не штрафуется за прошлое.
   */
  function mood(habits, log, today) {
    const active = habits.filter(h => !h.archivedAt);
    if (!active.length) return { mood: 'ok', empty: true, rate: 0, done: 0, scheduled: 0 };
    let done = 0, sched = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(today, -i);
      for (const h of active) {
        if (!isScheduled(h, day)) continue;
        const ok = doneOn(log, h, day);
        if (day === today) { if (ok) { done++; sched++; } } else { sched++; if (ok) done++; }
      }
    }
    const rate = sched ? done / sched : 0;
    const first = active.reduce((m, h) => (h.createdAt && h.createdAt < m ? h.createdAt : m), today);
    const young = first > addDays(today, -2); // меньше трёх дней опыта — сиять рано
    let m = rate < 0.3 ? 'sleepy' : rate < 0.6 ? 'ok' : rate < 0.85 ? 'happy' : 'glow';
    if (!sched) m = 'ok';
    else if (young && (m === 'glow' || m === 'sleepy')) m = m === 'glow' ? 'happy' : 'ok';
    return { mood: m, empty: false, rate, done, scheduled: sched };
  }

  const THRESHOLDS = [0, 5, 15, 30, 60, 100, 160, 240, 350, 500];
  const TITLES = ['Малыш', 'Любопытный', 'Читатель', 'Книгочей', 'Умница', 'Мудрец', 'Хранитель', 'Наставник', 'Сказитель', 'Легенда'];
  function totalDone(habits, log) {
    const ids = new Set(habits.map(h => h.id));
    let n = 0;
    for (const day of Object.keys(log || {})) for (const id of log[day]) if (ids.has(id)) n++;
    return n;
  }
  function level(xp) {
    let i = 0;
    while (i + 1 < THRESHOLDS.length && xp >= THRESHOLDS[i + 1]) i++;
    const last = i === THRESHOLDS.length - 1;
    return { level: i + 1, title: TITLES[i], xp, next: last ? null : THRESHOLDS[i + 1], into: xp - THRESHOLDS[i], need: last ? 0 : THRESHOLDS[i + 1] - THRESHOLDS[i] };
  }

  /** Отметить/снять отметку. Возвращает новый журнал (или тот же, если день недопустим). */
  function toggle(log, habitId, day, today) {
    if (day > today || day < addDays(today, -MAX_BACKFILL)) return log;
    const next = Object.assign({}, log);
    const cur = (next[day] || []).slice();
    const i = cur.indexOf(habitId);
    if (i >= 0) cur.splice(i, 1); else cur.push(habitId);
    if (cur.length) next[day] = cur; else delete next[day];
    return next;
  }

  function newHabit(o, today) {
    const name = String(o.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) return null;
    const days = Array.isArray(o.days) ? o.days.filter(d => d >= 0 && d <= 6).filter((d, i, a) => a.indexOf(d) === i).sort() : [];
    return { id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, emoji: String(o.emoji || '✅').slice(0, 8), days: days.length && days.length < 7 ? days : null, createdAt: today };
  }

  /** Сетка из 4 недель (с понедельника) для трекера: ячейки после сегодняшнего дня пустые. */
  function grid(h, log, today) {
    const wd = (weekday(today) + 6) % 7; // понедельник = 0
    const start = addDays(today, -wd - 21);
    const cells = [];
    for (let i = 0; i < 28; i++) {
      const day = addDays(start, i);
      cells.push({ day, future: day > today, scheduled: isScheduled(h, day), done: doneOn(log, h, day), today: day === today });
    }
    return cells;
  }

  /** Процент выполнения за последние 28 дней среди расписанных (сегодня считается, только если выполнено). */
  function monthRate(h, log, today) {
    let s = 0, d = 0;
    for (let i = 0; i < 28; i++) {
      const day = addDays(today, -i);
      if (!isScheduled(h, day)) continue;
      const ok = doneOn(log, h, day);
      if (day === today && !ok) continue;
      s++; if (ok) d++;
    }
    return s ? Math.round(d / s * 100) : 0;
  }

  return { ymd, parse, addDays, weekday, isScheduled, doneOn, streak, mood, level, totalDone, toggle, newHabit, grid, monthRate, MAX_HABITS, MAX_BACKFILL };
});
