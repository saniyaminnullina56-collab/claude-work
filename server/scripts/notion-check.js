// Проверка доступа к Notion. Запуск на сервере: NOTION_TOKEN=... NOTION_ROOT_PAGE_ID=... npm run notion:check
import { loadConfig } from '../src/config.js';
import { createNotion } from '../src/notion.js';

const c = loadConfig();
const hint = m => console.error('\n❌ ' + m);
if (!c.notionToken) { hint('Не задан NOTION_TOKEN (секрет интеграции Notion).'); process.exit(1); }
if (!c.notionRootPageId) { hint('Не задан NOTION_ROOT_PAGE_ID (идентификатор страницы «Читальня»).'); process.exit(1); }
const notion = createNotion({ token: c.notionToken });
try {
  const me = await notion.me();
  console.log(`✅ Токен верный. Интеграция: «${me.name || me.bot?.owner?.type || 'без имени'}»`);
} catch (e) { hint(`Токен не принят Notion (${e.message}). Скопируйте «Internal Integration Secret» заново, без пробелов.`); process.exit(1); }
try {
  const kids = await notion.children(c.notionRootPageId);
  const sections = kids.filter(b => b.type === 'child_page' && /^конспекты по прочитанным книгам/i.test(b.child_page.title));
  console.log(`✅ Страница «Читальня» открыта, вложенных страниц: ${kids.length}`);
  if (!sections.length) { hint('Страниц «Конспекты по прочитанным книгам …» внутри не найдено. Проверьте, что ID — именно страницы «Читальня».'); process.exit(1); }
  let total = 0;
  for (const s of sections) {
    const pages = (await notion.children(s.id)).filter(b => b.type === 'child_page');
    total += pages.length;
    console.log(`   • ${s.child_page.title}: ${pages.length} конспектов`);
  }
  console.log(`\n🎉 Всё готово: сервер увидит ${total} конспектов.`);
} catch (e) {
  hint(e.status === 404
    ? 'Notion не нашёл страницу. Откройте «Читальня» → «⋯» → «Подключения» → добавьте вашу интеграцию. Также проверьте NOTION_ROOT_PAGE_ID.'
    : `Ошибка Notion: ${e.message}`);
  process.exit(1);
}
