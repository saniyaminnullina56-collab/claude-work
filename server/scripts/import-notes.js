// Загружает конспекты из notes.json в базу (они больше не должны лежать на сайте открытым файлом).
// Запуск: DB_FILE=./data/bookclub.sqlite node scripts/import-notes.js ../notes.json
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';

const file = process.argv[2];
if (!file) { console.error('Укажите путь к notes.json'); process.exit(1); }
const notes = JSON.parse(fs.readFileSync(file, 'utf8'));
const store = openStore(loadConfig().dbFile);
let n = 0;
for (const [bid, note] of Object.entries(notes)) {
  if (!note || typeof note.content !== 'string') continue;
  store.set(['notes', bid], { content: note.content, updatedAt: note.updatedAt || '' });
  n++;
}
console.log(`Импортировано конспектов: ${n}`);
store.close();
