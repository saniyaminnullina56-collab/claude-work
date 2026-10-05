// Ручная настройка бота (обычно не нужна: сервер делает это сам при старте).
import { loadConfig } from '../src/config.js';
import { setupBot } from '../src/bot-setup.js';

const c = loadConfig();
if (!c.botToken || !c.publicUrl || !c.webhookSecret) { console.error('Нужны BOT_TOKEN, PUBLIC_URL, WEBHOOK_SECRET'); process.exit(1); }
if (!c.publicUrl.startsWith('https://')) { console.error('PUBLIC_URL должен начинаться с https://'); process.exit(1); }
await setupBot(c);
console.log('Готово: webhook, кнопка меню и команды настроены.');
