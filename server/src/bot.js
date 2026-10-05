// Telegram-бот: /start с кнопкой запуска Mini App и рассылка уведомлений.

const API = 'https://api.telegram.org';

export function createBot({ token, publicUrl, store, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  async function call(method, payload) {
    const res = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(data.description || `telegram ${method} failed`);
      err.code = data.error_code;
      throw err;
    }
    return data.result;
  }

  const openButton = (text, url = publicUrl) => ({ inline_keyboard: [[{ text, web_app: { url } }]] });

  async function handleUpdate(update) {
    const msg = update && update.message;
    if (!msg || !msg.from || !msg.text) return;
    const chatId = msg.chat.id;
    const cmd = msg.text.split(/\s|@/)[0];
    if (msg.chat.type === 'private') store.touchUser({
      id: msg.from.id, username: msg.from.username || '',
      name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Участница',
    });

    if (cmd === '/start' || cmd === '/help') {
      await call('sendMessage', {
        chat_id: chatId,
        text: '📚 Добро пожаловать в «Выручай-комнату»!\n\nЗдесь каталог книг клуба, обсуждения, цитаты, голосование за следующую книгу и конспекты. Нажмите кнопку ниже, чтобы открыть.\n\n/stop — отключить уведомления\n/notify — включить уведомления',
        reply_markup: openButton('📖 Открыть клуб'),
      });
    } else if (cmd === '/stop') {
      store.setNotify(msg.from.id, false);
      await call('sendMessage', { chat_id: chatId, text: 'Уведомления отключены. Вернуть: /notify' });
    } else if (cmd === '/notify') {
      store.setNotify(msg.from.id, true);
      await call('sendMessage', { chat_id: chatId, text: 'Уведомления включены 🔔' });
    }
  }

  /** Рассылка участницам с включёнными уведомлениями. Ошибки доставки не прерывают рассылку. */
  async function broadcast({ text, bookId }) {
    const url = bookId ? `${publicUrl}/?book=${encodeURIComponent(bookId)}` : publicUrl;
    const result = { sent: 0, failed: 0 };
    for (const u of store.allUsers().filter(u => u.notify)) {
      try {
        await call('sendMessage', { chat_id: u.id, text, reply_markup: openButton('📖 Открыть', url) });
        result.sent++;
      } catch (e) {
        result.failed++;
        if (e.code === 403) store.setNotify(u.id, false); // бот заблокирован — больше не пишем
        if (e.code === 429) await sleep(1500);
      }
      await sleep(40); // лимит Telegram ≈ 30 сообщений/с
    }
    return result;
  }

  return { call, handleUpdate, broadcast };
}
