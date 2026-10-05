// Что видно без оплаты: оглавление и первый раздел. Остальной текст сервер не отдаёт.
const MAX_PREVIEW = 2500;

export function previewOf(content) {
  const text = String(content || '');
  const lines = text.split('\n');
  const toc = [];
  const heads = []; // индексы строк-заголовков
  lines.forEach((l, i) => {
    const m = /^(#{1,3}) (.+)$/.exec(l);
    if (m) { toc.push({ level: m[1].length, title: m[2].trim().slice(0, 120) }); heads.push(i); }
  });
  let preview;
  if (heads.length) { // первый раздел: от первого заголовка до следующего
    preview = lines.slice(heads[0], heads.length > 1 ? heads[1] : lines.length).join('\n').trim();
    if (heads.length === 1) preview = preview.slice(0, Math.ceil(preview.length * 0.15)); // раздел один — показываем лишь начало
  } else { // без заголовков — только начало текста
    preview = text.slice(0, Math.min(600, Math.ceil(text.length * 0.15))).trim();
  }
  if (preview.length > MAX_PREVIEW) preview = preview.slice(0, MAX_PREVIEW).replace(/\s+\S*$/, '') + '…';
  return { locked: true, sections: toc.length, toc: toc.slice(0, 60), preview };
}
