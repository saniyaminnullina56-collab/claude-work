// Поиск обложек с проверкой совпадения: название, автор, язык. Подставляется только уверенное совпадение.
import { toks, hasCyrillic } from './text-match.js';

const ALLOWED_HOSTS = ['books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org'];
export const isAllowedCoverUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' && ALLOWED_HOSTS.includes(x.hostname); } catch { return false; } };

/** Оценка кандидата: confidence = high | medium | low. */
export function scoreCandidate(book, c) {
  const bt = toks(book.title);
  if (!bt.length) return { score: 0, confidence: 'low' };
  const title = new Set(toks(c.title));
  const full = new Set([...title, ...toks(c.subtitle)]);
  const coverage = bt.filter(t => full.has(t)).length / bt.length;
  const matched = bt.filter(t => title.has(t)).length;
  const precision = title.size ? Math.max(matched, bt.filter(t => full.has(t)).length * 0.999) / Math.max(title.size, bt.length) : 0;
  const ba = toks(book.author), ca = new Set(toks((c.authors || []).join(' ')));
  const authorOk = ba.length > 0 && ba.some(t => ca.has(t));
  const cyr = hasCyrillic(book.title);
  const langOk = !cyr || c.lang === 'ru';
  const score = Math.round(coverage * 50 + Math.min(1, precision) * 20 + (authorOk ? 25 : 0) + (langOk ? 5 : 0));
  let confidence = 'low';
  if (coverage >= 0.99 && precision >= 0.6 && langOk) confidence = authorOk || !ba.length ? 'high' : 'medium';
  if (confidence === 'high' && !ba.length) confidence = 'medium'; // без автора в каталоге уверенности нет
  else if (coverage < 0.6) confidence = 'low';
  return { score, confidence };
}

const upgradeGoogle = (id, links) => {
  if (!links || !(links.thumbnail || links.smallThumbnail)) return '';
  return `https://books.google.com/books/content?id=${encodeURIComponent(id)}&printsec=frontcover&img=1&zoom=1`;
};

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

async function googleCandidates(book, { fetchImpl, googleKey }) {
  const cyr = hasCyrillic(book.title);
  const queries = [];
  if (book.author) queries.push(`intitle:"${book.title}" inauthor:"${book.author}"`);
  queries.push(`intitle:"${book.title}"`);
  const out = [];
  for (const q of queries) {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&printType=books&maxResults=10${cyr ? '&langRestrict=ru' : ''}${googleKey ? `&key=${googleKey}` : ''}`;
    const d = await getJson(fetchImpl, url);
    for (const it of d.items || []) {
      const v = it.volumeInfo || {}, cover = upgradeGoogle(it.id, v.imageLinks);
      if (cover) out.push({ source: 'google', url: cover, title: v.title || '', subtitle: v.subtitle || '', authors: v.authors || [], lang: v.language || '', year: (v.publishedDate || '').slice(0, 4) });
    }
    if (out.length) break;
  }
  return out;
}

async function openLibraryCandidates(book, { fetchImpl }) {
  const p = new URLSearchParams({ title: book.title, limit: '10', fields: 'title,author_name,cover_i,language,first_publish_year' });
  if (book.author) p.set('author', book.author);
  const d = await getJson(fetchImpl, `https://openlibrary.org/search.json?${p}`);
  return (d.docs || []).filter(x => x.cover_i).map(x => ({
    source: 'openlibrary', url: `https://covers.openlibrary.org/b/id/${x.cover_i}-L.jpg`, title: x.title || '', subtitle: '',
    authors: x.author_name || [], lang: (x.language || []).includes('rus') ? 'ru' : (x.language || [])[0] || '', year: x.first_publish_year ? String(x.first_publish_year) : '',
  }));
}

/** Кандидаты из всех источников, лучшие сверху. Ошибка одного источника не мешает остальным. */
export async function findCovers(book, opts) {
  const all = []; const errors = [];
  for (const src of [googleCandidates, openLibraryCandidates]) {
    try { all.push(...await src(book, opts)); } catch (e) { errors.push(`${src === googleCandidates ? 'Google Books' : 'Open Library'}: ${e.message}`); }
  }
  const seen = new Set();
  const scored = all.map(c => ({ ...c, ...scoreCandidate(book, c) }))
    .sort((a, b) => b.score - a.score)
    .filter(c => (seen.has(c.url) ? false : seen.add(c.url)));
  return { candidates: scored.filter(c => c.confidence !== 'low' || c.score >= 40).slice(0, 6), errors };
}
