import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { verifyInitData } from './telegram.js';
import { parsePath } from './store.js';
import { checkRead, checkWrite, sanitizeConfig, ownKey, PUBLIC_READ } from './rules.js';
import { createBot } from './bot.js';
import { createNotion, syncNotion, bindPage } from './notion.js';
import { AVATARS } from './avatars.js';
import { previewOf } from './notes-preview.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://telegram.org",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  'img-src * data: blob:',
  "connect-src 'self' https://openlibrary.org https://api.themoviedb.org",
  "base-uri 'none'", "object-src 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ store, config, fetchImpl = fetch, sleep, notionClient }) {
  const bot = config.botToken && config.publicUrl
    ? createBot({ token: config.botToken, publicUrl: config.publicUrl, store, fetchImpl, sleep })
    : null;

  // ── Notion ──
  const notion = notionClient || (config.notionToken && config.notionRootPageId ? createNotion({ token: config.notionToken, fetchImpl, sleep }) : null);
  let notionRunning = false;
  async function runNotionSync() {
    if (!notion) throw new HttpError(503, 'Notion не настроен (нужны NOTION_TOKEN и NOTION_ROOT_PAGE_ID)');
    if (notionRunning) return null;
    notionRunning = true;
    try { return await syncNotion({ store, notion, rootPageId: config.notionRootPageId }); }
    catch (e) {
      const st = store.get(['notionState']).value || {};
      const message = e.status === 401 ? 'Notion не принял токен. Скопируйте «Internal Integration Secret» заново и вставьте в NOTION_TOKEN без пробелов.'
        : e.status === 404 ? 'Notion не нашёл страницу «Читальня». Откройте её → «⋯» → «Подключения» → добавьте вашу интеграцию; проверьте и NOTION_ROOT_PAGE_ID.'
        : e.message;
      st.lastError = { at: new Date().toISOString(), message };
      store.set(['notionState'], st);
      throw e;
    } finally { notionRunning = false; }
  }

  // ── ограничение частоты ──
  const buckets = new Map();
  function limit(key, max, windowMs) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    if (++b.n > max) throw new HttpError(429, 'Слишком много запросов, попробуйте позже');
  }
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

  // ── аутентификация ──
  function authenticate(req) {
    const h = String(req.headers.authorization || '');
    let tg = null;
    if (h.startsWith('tma ')) tg = verifyInitData(h.slice(4), config.botToken, config.initDataMaxAgeSec);
    else if (config.devAuth && h.startsWith('dev ')) {
      const [id, ...rest] = h.slice(4).split('|');
      if (Number.isSafeInteger(Number(id)) && Number(id) > 0) tg = { id: Number(id), name: decodeURIComponent(rest.join('|')) || `Dev ${id}`, username: '' };
    }
    if (!tg) throw new HttpError(401, 'Откройте приложение через Telegram');
    let row = store.getUser(tg.id);
    if (!row) {
      // имена используются в подписях и голосах, поэтому они уникальны
      let name = tg.name, i = 1;
      const taken = new Set(store.allUsers().map(u => u.name));
      while (taken.has(name)) name = `${tg.name} ${++i}`;
      row = store.touchUser({ ...tg, name });
    } else row = store.touchUser({ ...tg, name: row.name });
    const isAdmin = config.adminIds.includes(row.id);
    const pro = isAdmin || store.entitlements(row.id).includes('*'); // платная личная библиотека
    return { id: row.id, name: row.name, avatar: row.avatar, username: row.username, isAdmin, pro, key: ownKey(row) };
  }

  const entitled = (user, bid) => {
    if (user.isAdmin) return true;
    const e = store.entitlements(user.id);
    return e.includes('*') || (bid != null && e.includes(String(bid)));
  };
  const meOf = user => ({
    id: user.id, key: user.key, name: user.name, avatar: user.avatar,
    isAdmin: user.isAdmin, entitlements: store.entitlements(user.id),
  });

  // ── чтение/запись ──
  // Содержимое корня с учётом того, что этой участнице можно видеть.
  function rootValue(root, user) {
    let { value, rev } = store.get([root]);
    if (root === 'config') { value = sanitizeConfig(value, user); if (config.channelUrl && !(value && value.channelUrl)) value = { ...(value || {}), channelUrl: config.channelUrl }; }
    if (root === 'personalReviews' && !user.pro) value = null;
    if (root === 'userdata') value = value && value[user.key] !== undefined ? { [user.key]: value[user.key] } : null;
    return { value, rev };
  }

  function readValue(segs, user) {
    if (checkRead(segs, user)) throw new HttpError(403, 'Нет доступа');
    let { value, rev } = rootValue(segs[0], user);
    for (const s of segs.slice(1)) {
      if (value === null || typeof value !== 'object') { value = null; break; }
      value = Object.hasOwn(value, s) ? value[s] : null;
    }
    return { value: value ?? null, rev };
  }

  function listForRoot(root) {
    return store.allUsers().map(u => ({ id: `u${u.id}`, name: u.name, role: u.role || '', avatar: u.avatar, isAdmin: config.adminIds.includes(u.id) }));
  }

  function sync(user, known) {
    const roots = {};
    const names = [...PUBLIC_READ, 'userdata', 'members'];
    for (const root of names) {
      let value, rev;
      if (root === 'members') {
        value = listForRoot();
        rev = crypto.createHash('md5').update(JSON.stringify(value)).digest('hex').slice(0, 10);
      } else {
        ({ value, rev } = rootValue(root, user));
        rev = String(rev);
      }
      if (known && known[root] === rev) continue;
      roots[root] = { rev, value };
    }
    return { roots };
  }

  function write(user, method, segs, body) {
    if (!segs.length) throw new HttpError(400, 'Пустой путь');
    const cur = store.get(segs).value;
    let target = segs, newVal = body.value ?? null;
    if (method === 'DELETE') newVal = null;
    if (method === 'POST') { // добавить в конец списка
      if (cur !== null && !Array.isArray(cur) && typeof cur !== 'object') throw new HttpError(400, 'Нельзя добавить сюда');
      if (cur && !Array.isArray(cur)) { // объект с ключами — добавляем по новому ключу
        const key = store.newKey();
        target = [...segs, key]; newVal = body.value;
        const err = checkWrite(target, newVal, null, user);
        if (err) throw new HttpError(403, err);
        store.set(target, newVal);
        return { key };
      }
      const list = [...(cur || []), body.value];
      const err = checkWrite(segs, list, cur, user);
      if (err) throw new HttpError(403, err);
      store.set(segs, list);
      return { key: body.value && body.value.id != null ? String(body.value.id) : String(list.length - 1) };
    }
    const err = checkWrite(target, newVal, cur, user);
    if (err) throw new HttpError(403, err);
    store.set(target, newVal);
    return { ok: true };
  }

  // ── доступ к платным конспектам ──
  const safeEq = (a, b) => {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  function redeem(user, { code, bookId }) {
    limit(`redeem:${user.id}`, 8, 10 * 60_000);
    const cfg = store.get(['config']).value || {};
    const attempt = String(code || '').trim().toUpperCase();
    if (!attempt || attempt.length > 80) throw new HttpError(400, 'Введите код доступа');
    const bookCode = bookId && cfg.bookPayInfo && cfg.bookPayInfo[bookId] && cfg.bookPayInfo[bookId].code;
    let scope = null;
    if (bookCode && safeEq(attempt, String(bookCode).toUpperCase())) scope = String(bookId);
    else if (cfg.proCode && safeEq(attempt, String(cfg.proCode).toUpperCase())) scope = '*';
    if (!scope) throw new HttpError(403, 'Неверный код');
    store.grant(user.id, scope, 'code');
    return { scope, entitlements: store.entitlements(user.id) };
  }

  function notesFor(user) {
    const notes = store.get(['notes']).value || {};
    const out = {};
    for (const [bid, n] of Object.entries(notes)) out[bid] = entitled(user, bid) ? n : previewOf(n && n.content);
    return out;
  }

  // ── HTTP ──
  async function readBody(req, maxBytes) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > maxBytes) throw new HttpError(413, 'Слишком большой запрос');
      chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Неверный JSON'); }
  }

  function send(req, res, status, data, extra = {}) {
    let body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra };
    if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip';
    }
    res.writeHead(status, headers);
    res.end(body);
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(req, res, 404, { error: 'Не найдено' });
    const ext = path.extname(file);
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' };
    if (ext === '.html') headers['content-security-policy'] = CSP;
    send(req, res, 200, fs.readFileSync(file), headers);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/healthz') return send(req, res, 200, { ok: true });
      if (!p.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
        return serveStatic(req, res, p);
      }

      // Webhook бота: подлинность — по секретному заголовку, а не по initData
      if (p === '/api/bot/webhook' && req.method === 'POST') {
        if (!bot || !config.webhookSecret || !safeEq(req.headers['x-telegram-bot-api-secret-token'] || '', config.webhookSecret)) throw new HttpError(403, 'forbidden');
        const update = await readBody(req, 100_000);
        bot.handleUpdate(update).catch(e => console.error('bot error:', e.message));
        return send(req, res, 200, { ok: true });
      }

      const user = authenticate(req);
      limit(`req:${user.id}`, 600, 60_000);
      const method = req.method;

      if (p === '/api/me' && method === 'GET') return send(req, res, 200, meOf(user));

      if (p === '/api/profile' && method === 'POST') {
        const body = await readBody(req, 2000);
        const next = { ...user };
        if (body.name !== undefined) {
          const n = String(body.name || '').trim().replace(/\s+/g, ' ');
          if (n.length < 1 || n.length > 40) throw new HttpError(400, 'Имя: от 1 до 40 символов');
          if (store.allUsers().some(u => u.id !== user.id && u.name.toLowerCase() === n.toLowerCase())) throw new HttpError(409, 'Такое имя уже занято');
          store.setName(user.id, n); next.name = n;
        }
        if (body.avatar !== undefined) {
          if (!AVATARS.includes(body.avatar)) throw new HttpError(400, 'Неизвестный аватар');
          store.setAvatar(user.id, body.avatar); next.avatar = body.avatar;
        }
        return send(req, res, 200, meOf(next));
      }

      if (p === '/api/sync' && method === 'POST') {
        const body = await readBody(req, 20_000);
        return send(req, res, 200, sync(user, body.revs));
      }

      if (p.startsWith('/api/db/')) {
        const segs = parsePath(p.slice('/api/db/'.length));
        if (!segs || !segs.length) throw new HttpError(400, 'Неверный путь');
        if (method === 'GET') return send(req, res, 200, readValue(segs, user));
        if (['PUT', 'POST', 'DELETE'].includes(method)) {
          const body = method === 'DELETE' ? {} : await readBody(req, user.isAdmin ? 3_000_000 : 300_000);
          return send(req, res, 200, write(user, method, segs, body));
        }
        throw new HttpError(405, 'Метод не поддерживается');
      }

      if (p === '/api/redeem' && method === 'POST') return send(req, res, 200, redeem(user, await readBody(req, 2000)));

      if (p === '/api/notes' && method === 'GET') return send(req, res, 200, notesFor(user));
      if (p.startsWith('/api/notes/') && ['PUT', 'DELETE'].includes(method)) {
        if (!user.isAdmin) throw new HttpError(403, 'Только организатор');
        const segs = parsePath(p.slice('/api/notes/'.length));
        if (!segs || segs.length !== 1) throw new HttpError(400, 'Неверный путь');
        if (method === 'DELETE') store.set(['notes', segs[0]], null);
        else {
          const { content, updatedAt } = await readBody(req, 3_000_000);
          if (typeof content !== 'string') throw new HttpError(400, 'Нужен content');
          store.set(['notes', segs[0]], { content, updatedAt: updatedAt || new Date().toISOString().slice(0, 10) });
        }
        return send(req, res, 200, { ok: true });
      }

      if (p.startsWith('/api/admin/')) {
        if (!user.isAdmin) throw new HttpError(403, 'Только организатор');
        const body = method === 'GET' ? {} : await readBody(req, 10_000);
        if (p === '/api/admin/users' && method === 'GET') {
          return send(req, res, 200, store.allUsers().map(u => ({ id: u.id, name: u.name, username: u.username, notify: !!u.notify, entitlements: store.entitlements(u.id) })));
        }
        if (p === '/api/admin/notion' && method === 'GET') {
          const st = store.get(['notionState']).value || {};
          const inbox = Object.values(store.get(['notionInbox']).value || {});
          return send(req, res, 200, {
            configured: !!notion, running: notionRunning, lastRun: st.lastRun || null, lastResult: st.lastResult || null, lastError: st.lastError || null,
            matches: Object.values(st.pages || {}).map(p => ({ title: p.title, bookId: p.bookId })),
            inbox: inbox.map(i => ({ pageId: i.pageId, title: i.title, section: i.section, chars: (i.content || '').length })),
          });
        }
        if (p === '/api/admin/notion/sync' && method === 'POST') {
          if (!notion) throw new HttpError(503, 'Notion не настроен (нужны NOTION_TOKEN и NOTION_ROOT_PAGE_ID)');
          limit(`notion:${user.id}`, 6, 3600_000);
          runNotionSync().then(r => r && console.log('notion sync', r)).catch(e => console.error('notion sync failed:', e.message));
          return send(req, res, 202, { started: true });
        }
        if (p === '/api/admin/notion/bind' && method === 'POST') {
          try { return send(req, res, 200, { bookId: bindPage({ store, pageId: String(body.pageId || ''), bookId: body.bookId, create: body.create }) }); }
          catch (e) { throw new HttpError(e.status || 400, e.message); }
        }
        if ((p === '/api/admin/grant' || p === '/api/admin/revoke') && method === 'POST') {
          const uid = Number(body.userId), scope = String(body.scope || '');
          if (!store.getUser(uid) || !scope) throw new HttpError(400, 'Неверные данные');
          if (p.endsWith('grant')) store.grant(uid, scope, 'admin'); else store.revoke(uid, scope);
          return send(req, res, 200, { entitlements: store.entitlements(uid) });
        }
        if (p === '/api/admin/broadcast' && method === 'POST') {
          if (!bot) throw new HttpError(503, 'Бот не настроен (BOT_TOKEN, PUBLIC_URL)');
          const text = String(body.text || '').trim();
          if (!text || text.length > 3500) throw new HttpError(400, 'Текст: от 1 до 3500 символов');
          limit(`broadcast:${user.id}`, 5, 3600_000);
          const recipients = store.allUsers().filter(u => u.notify).length;
          bot.broadcast({ text, bookId: body.bookId }).then(r => console.log('broadcast', r)).catch(e => console.error('broadcast failed:', e.message));
          return send(req, res, 202, { queued: recipients });
        }
      }

      throw new HttpError(404, 'Не найдено');
    } catch (e) {
      if (e instanceof HttpError) return send(req, res, e.status, { error: e.message });
      console.error(e);
      return send(req, res, 500, { error: 'Ошибка сервера' });
    }
  }

  return { handle, server: () => http.createServer(handle), bot, notion, runNotionSync };
}
