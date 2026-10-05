import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { createApp } from './app.js';
import { setupBot } from './bot-setup.js';

const config = loadConfig();
if (process.env.NODE_ENV === 'production' && !config.botToken) { console.error('BOT_TOKEN обязателен в production'); process.exit(1); }
if (!config.adminIds.length) console.warn('ADMIN_IDS не задан — организаторов нет');

if (config.botToken && config.publicUrl && config.webhookSecret) {
  if (!config.publicUrl.startsWith('https://')) console.error('PUBLIC_URL должен начинаться с https:// — бот не настроен');
  else setupBot(config).then(() => console.log('Бот настроен: webhook, кнопка «Клуб», команды'), e => console.error('Не удалось настроить бота:', e.message));
} else console.warn('Бот не настроен: нужны BOT_TOKEN, PUBLIC_URL, WEBHOOK_SECRET');

const store = openStore(config.dbFile);
const app = createApp({ store, config });
const server = app.server();
if (app.notion) { // конспекты из Notion: при старте и затем по расписанию
  const tick = () => app.runNotionSync().then(r => r && console.log('notion sync', JSON.stringify(r))).catch(e => console.error('notion sync failed:', e.message));
  setTimeout(tick, 10_000);
  setInterval(tick, Math.max(5, config.notionIntervalMin) * 60_000).unref();
} else console.warn('Notion не настроен — конспекты добавляются вручную или через import-notes.js');
server.listen(config.port, () => console.log(`bookclub server on :${config.port}${config.devAuth ? ' (DEV_AUTH)' : ''}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => { store.close(); process.exit(0); }));
