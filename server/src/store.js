import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BAD_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function parsePath(p) {
  const segs = String(p || '').split('/').filter(Boolean);
  if (segs.length > 6) return null;
  for (const s of segs) {
    if (s.length > 100 || BAD_SEGMENTS.has(s) || !/^[\w\-.а-яёА-ЯЁ]+$/u.test(s)) return null;
  }
  return segs;
}

/** Хранилище: дерево JSON по корневым ключам (как в Realtime Database) + таблицы пользователей и доступа. */
export function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS tree (root TEXT PRIMARY KEY, json TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT DEFAULT '', role TEXT DEFAULT '',
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, notify INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS entitlements (
      user_id INTEGER NOT NULL, scope TEXT NOT NULL, granted_at INTEGER NOT NULL, source TEXT DEFAULT 'code',
      PRIMARY KEY (user_id, scope));
  `);

  const q = {
    getRoot: db.prepare('SELECT json, rev FROM tree WHERE root = ?'),
    putRoot: db.prepare(`INSERT INTO tree(root, json, rev) VALUES (?, ?, 1)
      ON CONFLICT(root) DO UPDATE SET json = excluded.json, rev = rev + 1`),
    delRoot: db.prepare('DELETE FROM tree WHERE root = ?'),
    upsertUser: db.prepare(`INSERT INTO users(id, name, username, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET username = excluded.username, last_seen = excluded.last_seen`),
    getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
    allUsers: db.prepare('SELECT * FROM users ORDER BY first_seen'),
    setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    setNotify: db.prepare('UPDATE users SET notify = ? WHERE id = ?'),
    ents: db.prepare('SELECT scope FROM entitlements WHERE user_id = ?'),
    grant: db.prepare(`INSERT INTO entitlements(user_id, scope, granted_at, source) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, scope) DO NOTHING`),
    revoke: db.prepare('DELETE FROM entitlements WHERE user_id = ? AND scope = ?'),
  };

  function readRoot(root) {
    const row = q.getRoot.get(root);
    return row ? { value: JSON.parse(row.json), rev: row.rev } : { value: null, rev: 0 };
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  return {
    raw: db,
    close: () => db.close(),

    /** Читает значение по пути; rev — ревизия корня (для опроса без лишнего трафика). */
    get(segs) {
      if (!segs.length) return { value: null, rev: 0 };
      const { value, rev } = readRoot(segs[0]);
      let cur = value;
      for (const s of segs.slice(1)) {
        if (cur === null || typeof cur !== 'object') return { value: null, rev };
        cur = Object.hasOwn(cur, s) ? cur[s] : null;
        if (cur === undefined) cur = null;
      }
      return { value: cur ?? null, rev };
    },

    /** Записывает значение (null — удалить). Возвращает новую ревизию корня. */
    set(segs, val) {
      if (!segs.length) throw new Error('empty path');
      return transaction(() => {
        const root = segs[0];
        if (segs.length === 1) {
          if (val === null || val === undefined) { q.delRoot.run(root); return 0; }
          q.putRoot.run(root, JSON.stringify(val));
          return readRoot(root).rev;
        }
        let tree = readRoot(root).value;
        if (tree === null || typeof tree !== 'object') tree = {};
        let cur = tree;
        for (const s of segs.slice(1, -1)) {
          if (cur[s] === null || typeof cur[s] !== 'object') cur[s] = {};
          cur = cur[s];
        }
        const last = segs[segs.length - 1];
        if (val === null || val === undefined) {
          if (Array.isArray(cur)) cur.splice(Number(last), 1); else delete cur[last];
        } else cur[last] = val;
        q.putRoot.run(root, JSON.stringify(tree));
        return readRoot(root).rev;
      });
    },

    newKey() {
      return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    },

    // ── пользователи ──
    touchUser(u) {
      const now = Date.now();
      q.upsertUser.run(u.id, u.name, u.username || '', now, now);
      return q.getUser.get(u.id);
    },
    getUser: id => q.getUser.get(id) || null,
    allUsers: () => q.allUsers.all(),
    setName: (id, name) => q.setName.run(name, id),
    setNotify: (id, on) => q.setNotify.run(on ? 1 : 0, id),

    // ── доступ к платным материалам ──
    entitlements: id => q.ents.all(id).map(r => r.scope),
    grant: (id, scope, source = 'code') => q.grant.run(id, scope, Date.now(), source),
    revoke: (id, scope) => q.revoke.run(id, scope),
    transaction,
  };
}
