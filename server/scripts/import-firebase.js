// Перенос данных из Firebase Realtime Database.
// 1) Firebase Console → Realtime Database → ⋮ → «Export JSON» → сохраните файл.
// 2) Создайте name-map.json: { "Анна": 123456789, "Мария": 987654321 } (имя в клубе → Telegram ID).
// 3) DB_FILE=./data/bookclub.sqlite node scripts/import-firebase.js export.json name-map.json
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { convertFirebase } from '../src/migrate.js';

const [exportFile, mapFile] = process.argv.slice(2);
if (!exportFile) { console.error('Использование: import-firebase.js export.json [name-map.json]'); process.exit(1); }
const tree = convertFirebase(JSON.parse(fs.readFileSync(exportFile, 'utf8')), mapFile ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {});
const store = openStore(loadConfig().dbFile);
for (const [root, value] of Object.entries(tree)) { store.set([root], value); console.log('импортировано:', root); }
store.close();
