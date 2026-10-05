// Настройка бота: webhook, кнопка меню «Клуб», команды. Выполняется при каждом старте сервера (идемпотентно).
import { createBot } from './bot.js';

export async function setupBot(c, fetchImpl = fetch) {
  const bot = createBot({ token: c.botToken, publicUrl: c.publicUrl, store: null, fetchImpl });
  await bot.call('setWebhook', { url: `${c.publicUrl}/api/bot/webhook`, secret_token: c.webhookSecret, allowed_updates: ['message'] });
  await bot.call('setChatMenuButton', { menu_button: { type: 'web_app', text: '📖 Клуб', web_app: { url: c.publicUrl } } });
  await bot.call('setMyCommands', { commands: [
    { command: 'start', description: 'Открыть клуб' },
    { command: 'stop', description: 'Отключить уведомления' },
    { command: 'notify', description: 'Включить уведомления' },
  ] });
}
