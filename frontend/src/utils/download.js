// Save a chat exchange as a self-contained .html file: opens in any browser with
// its formatting preserved, and can be printed to PDF. The file holds THREE parts:
//   1. the user's question
//   2. the bot's answer
//   3. the sources the answer was based on (document + page, with the excerpt)
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
  .dl-section { margin: 0 0 22px; }
  .dl-label { font-size: 0.82rem; font-weight: 700; color: #5b7fb0; margin: 0 0 6px; }
  .dl-question { background: #eef1f6; border-radius: 12px; padding: 12px 16px; margin: 0; font-weight: 600; }
  .dl-divider { border: none; border-top: 1px solid #e6e8ec; margin: 22px 0; }
  .dl-sources { list-style: none; padding: 0; margin: 0; }
  .dl-source { border: 1px solid #e6e8ec; border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; }
  .dl-source-name { font-weight: 600; }
  .dl-excerpt { margin: 8px 0 0; padding-inline-start: 12px; border-inline-start: 3px solid #d9dce2;
                color: #4b5563; font-size: 0.94rem; white-space: pre-wrap; }
  .dl-meta { color: #8a90a0; font-size: 0.8rem; margin: 0 0 22px; }
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

// Build the sources section: each document + page, with the excerpt it drew from.
function sourcesHtml(sources) {
  if (!Array.isArray(sources) || !sources.length) return "";
  const items = sources
    .map((s) => {
      const name = `📄 ${esc(s.source)} · עמוד ${esc(s.page_number)}`;
      const excerpt = s.text
        ? `<blockquote class="dl-excerpt">${esc(s.text)}</blockquote>`
        : "";
      return `<li class="dl-source"><div class="dl-source-name">${name}</div>${excerpt}</li>`;
    })
    .join("");
  return (
    `<hr class="dl-divider">` +
    `<div class="dl-section"><p class="dl-label">מקורות (${sources.length})</p>` +
    `<ul class="dl-sources">${items}</ul></div>`
  );
}

// Strip characters a filename can't contain, and keep it short.
function safeFileName(name) {
  const clean = String(name).replace(/[\\/:*?"<>|\n\r]+/g, " ").trim();
  return (clean.slice(0, 50) || "עוזר-החברה");
}

/**
 * Save one exchange to an .html file.
 * opts: { element, rawText, question, sources, title }
 *  - element : the rendered answer node (used for non-template answers)
 *  - rawText : the answer's raw markdown (used to rebuild flashcards/quiz)
 *  - question: the user's question (shown at the top)
 *  - sources : [{ source, page_number, text }] the answer was based on
 */
export function downloadAnswer(opts) {
  const { element, rawText, question = "", sources = [], title = "עוזר-החברה" } = opts;

  // --- the answer body (rebuilt for interactive answers, else as rendered) ---
  const caption = captionBefore(rawText);
  const capHtml = caption ? `<p>${esc(caption)}</p>` : "";
  let answerHtml = null;
  const fc = fenceContent(rawText, "flashcards");
  const qz = fenceContent(rawText, "quiz");
  if (fc) answerHtml = capHtml + (flashcardsHtml(fc) || "");
  else if (qz) answerHtml = capHtml + (quizHtml(qz) || "");
  if (!answerHtml) answerHtml = element?.innerHTML || ""; // everything else
  if (!answerHtml) return;

  // --- assemble question + answer + sources ---
  const questionHtml = question
    ? `<div class="dl-section"><p class="dl-label">השאלה</p>` +
      `<p class="dl-question">${esc(question)}</p></div>`
    : "";
  const answerSection =
    `<div class="dl-section"><p class="dl-label">התשובה</p>${answerHtml}</div>`;
  const meta = `<p class="dl-meta">נשמר מתוך עוזר החברה · ${esc(
    new Date().toLocaleDateString("he-IL")
  )}</p>`;

  const doc =
    '<!doctype html>\n<html lang="he" dir="rtl"><head><meta charset="utf-8">' +
    `<title>${esc(title)}</title><style>${STYLES}</style></head><body>` +
    meta +
    questionHtml +
    answerSection +
    sourcesHtml(sources) +
    "</body></html>";

  const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  // Name the file after the question so saved files are distinguishable.
  link.download = `${safeFileName(question || title)}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
