// Одноразовая настройка бота: webhook, кнопка меню «Открыть клуб», список команд.
// BOT_TOKEN=... PUBLIC_URL=https://club.example.com WEBHOOK_SECRET=... node scripts/setup-bot.js
import { loadConfig } from '../src/config.js';
import { createBot } from '../src/bot.js';

const c = loadConfig();
if (!c.botToken || !c.publicUrl || !c.webhookSecret) { console.error('Нужны BOT_TOKEN, PUBLIC_URL, WEBHOOK_SECRET'); process.exit(1); }
if (!c.publicUrl.startsWith('https://')) { console.error('PUBLIC_URL должен быть https://'); process.exit(1); }
const bot = createBot({ token: c.botToken, publicUrl: c.publicUrl, store: null });
await bot.call('setWebhook', { url: `${c.publicUrl}/api/bot/webhook`, secret_token: c.webhookSecret, allowed_updates: ['message'] });
await bot.call('setChatMenuButton', { menu_button: { type: 'web_app', text: '📖 Клуб', web_app: { url: c.publicUrl } } });
await bot.call('setMyCommands', { commands: [
  { command: 'start', description: 'Открыть клуб' },
  { command: 'stop', description: 'Отключить уведомления' },
  { command: 'notify', description: 'Включить уведомления' },
] });
console.log('Готово: webhook, кнопка меню и команды настроены.');
