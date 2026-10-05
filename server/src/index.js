import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { createApp } from './app.js';

const config = loadConfig();
if (process.env.NODE_ENV === 'production' && !config.botToken) { console.error('BOT_TOKEN обязателен в production'); process.exit(1); }
if (!config.adminIds.length) console.warn('ADMIN_IDS не задан — организаторов нет');

const store = openStore(config.dbFile);
const app = createApp({ store, config });
const server = app.server();
server.listen(config.port, () => console.log(`bookclub server on :${config.port}${config.devAuth ? ' (DEV_AUTH)' : ''}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => { store.close(); process.exit(0); }));
