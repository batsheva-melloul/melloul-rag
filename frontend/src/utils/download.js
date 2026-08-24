// Save a bot answer as a self-contained .html file: opens in any browser with its
// formatting preserved, and can be printed to PDF.
//
// For interactive answers we build a COMPLETE static version from the raw text:
//   - flashcards  -> every card with BOTH its question and answer
//   - quiz        -> every question with its options, the correct one marked
// For everything else (study guide / summary / FAQ / tables / infographics) we use
// the already-rendered HTML, which looks the same as on screen.

const STYLES = `
  body { direction: rtl; font-family: "Segoe UI", Arial, sans-serif; color: #1f2430;
         background: #fff; max-width: 820px; margin: 28px auto; padding: 0 22px;
         line-height: 1.6; }
  h1,h2,h3,h4 { line-height: 1.3; }
  ul,ol { padding-inline-start: 22px; }
  strong { font-weight: 700; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; }
  th,td { border: 1px solid #d9dce2; padding: 8px 12px; text-align: right; vertical-align: top; }
  thead th { background: #eef1f6; }
  .infographic { border: 1px solid #e6e8ec; border-radius: 12px; padding: 14px; margin: 14px 0; }
  .infographic svg, .infographic img { max-width: 100%; height: auto; }
  .flashcard-hint, .quiz-score, .quiz-reset { display: none; }
  .ex-cards { display: grid; grid-template-columns: repeat(auto-fill,minmax(240px,1fr)); gap: 12px; margin: 14px 0; }
  .ex-card { border: 1px solid #d9dce2; border-radius: 12px; padding: 14px; }
  .ex-card .ex-q { margin-bottom: 8px; }
  .ex-quiz { display: flex; flex-direction: column; gap: 14px; margin: 14px 0; }
  .ex-quiz-q ul { list-style: none; padding: 0; margin: 6px 0 0; }
  .ex-quiz-q li { padding: 6px 10px; border: 1px solid #d9dce2; border-radius: 8px; margin-bottom: 6px; }
  .ex-quiz-q li.ex-correct { border-color: #2f9a5f; background: rgba(47,154,95,0.12); font-weight: 600; }
`;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function fenceContent(text, lang) {
  const m = new RegExp("```" + lang + "\\s*([\\s\\S]*?)```").exec(text || "");
  return m ? m[1].trim() : null;
}

function captionBefore(text) {
  const i = (text || "").indexOf("```");
  return i > 0 ? text.slice(0, i).trim() : "";
}

function flashcardsHtml(block) {
  const cards = [];
  for (const part of block.split(/\n\s*\n/)) {
    const q = /Q:\s*(.*)/.exec(part)?.[1]?.trim();
    const a = /A:\s*([\s\S]*)/.exec(part)?.[1]?.trim();
    if (q && a) cards.push({ q, a });
  }
  if (!cards.length) return null;
  const items = cards
    .map(
      (c) =>
        `<div class="ex-card"><div class="ex-q"><b>שאלה:</b> ${esc(c.q)}</div>` +
        `<div class="ex-a"><b>תשובה:</b> ${esc(c.a)}</div></div>`
    )
    .join("");
  return `<div class="ex-cards">${items}</div>`;
}

function quizHtml(block) {
  let data;
  try {
    data = JSON.parse(block.slice(block.indexOf("["), block.lastIndexOf("]") + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(data) || !data.length) return null;
  const items = data
    .map((q, i) => {
      const opts = (q.options || [])
        .map(
          (o, oi) =>
            `<li${oi === q.correct ? ' class="ex-correct"' : ""}>${esc(o)}` +
            `${oi === q.correct ? " ✓" : ""}</li>`
        )
        .join("");
      return `<div class="ex-quiz-q"><div class="ex-q"><b>${i + 1}.</b> ${esc(q.q)}</div><ul>${opts}</ul></div>`;
    })
    .join("");
  return `<div class="ex-quiz">${items}</div>`;
}

export function downloadAnswer(element, rawText, title = "עוזר-החברה") {
  const caption = captionBefore(rawText);
  const capHtml = caption ? `<p>${esc(caption)}</p>` : "";

  let inner = null;
  const fc = fenceContent(rawText, "flashcards");
  const qz = fenceContent(rawText, "quiz");
  if (fc) inner = capHtml + (flashcardsHtml(fc) || "");
  else if (qz) inner = capHtml + (quizHtml(qz) || "");
  if (!inner) inner = element?.innerHTML || ""; // everything else: as rendered
  if (!inner) return;

  const doc =
    '<!doctype html>\n<html lang="he" dir="rtl"><head><meta charset="utf-8">' +
    `<title>${esc(title)}</title><style>${STYLES}</style></head><body>` +
    inner +
    "</body></html>";

  const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
