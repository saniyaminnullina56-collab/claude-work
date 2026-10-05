import crypto from 'node:crypto';

/**
 * Проверка Telegram WebApp initData по официальной схеме:
 * secret = HMAC_SHA256("WebAppData", bot_token); hash = HMAC_SHA256(secret, data_check_string).
 * Возвращает { id, name, username } или null, если подпись неверна / данные устарели.
 */
export function verifyInitData(initData, botToken, maxAgeSec = 86400, now = Date.now()) {
  if (!initData || !botToken || typeof initData !== 'string' || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== calc.length || !crypto.timingSafeEqual(given, calc)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeSec || authDate - now / 1000 > 300) return null;

  let user;
  try { user = JSON.parse(params.get('user') || ''); } catch { return null; }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || 'Участница';
  return { id: user.id, name: name.slice(0, 60), username: user.username || '' };
}

/** Только для тестов: собирает корректную подпись. */
export function signInitData(fields, botToken) {
  const params = new URLSearchParams(fields);
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
