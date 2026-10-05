// Приводит экспорт Notion к простому markdown, который понимает notionToHtml() в интерфейсе.
export function cleanNote(text) {
  let t = String(text || '');
  // экспорт был экранирован дважды: «\n» лежит в тексте буквально
  if ((t.match(/\\n/g) || []).length > (t.match(/\n/g) || []).length) {
    t = t.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  t = t
    .replace(/<empty-block\s*\/?>(<\/empty-block>)?/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<summary>([\s\S]*?)<\/summary>/g, '**$1**\n')
    .replace(/<\/?(span|columns?|details|content|page|embed|file)\b[^>]*>/g, '')
    .replace(/^[ \t]+/gm, '')        // отступы из Notion превращаются в «код» и ломают абзацы
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t;
}
