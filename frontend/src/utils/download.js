// Save a rendered answer as a self-contained .html file: opens in any browser with
// its formatting (tables, infographics, cards, quiz questions) preserved, and can be
// printed to PDF. Interactive parts (flashcards / quiz) save in their visible state.

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
  .flashcards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px,1fr)); gap: 12px; margin: 14px 0; }
  .flashcard { display: flex; flex-direction: column; gap: 6px; min-height: 100px;
               padding: 14px; border: 1px solid #d9dce2; border-radius: 12px; text-align: right; }
  .flashcard-label { font-size: 12px; font-weight: 700; color: #466493; }
  .flashcard-hint { display: none; }
  .quiz { display: flex; flex-direction: column; gap: 16px; margin: 14px 0; }
  .quiz-q-text { font-weight: 600; margin-bottom: 8px; }
  .quiz-options { display: flex; flex-direction: column; gap: 8px; }
  .quiz-option { padding: 9px 13px; border: 1px solid #d9dce2; border-radius: 10px; text-align: right; }
  .quiz-option.correct { border-color: #2f9a5f; background: rgba(47,154,95,0.12); }
  .quiz-score, .quiz-reset { display: none; }
`;

export function downloadAnswer(innerHtml, title = "עוזר-החברה") {
  if (!innerHtml) return;
  const doc =
    '<!doctype html>\n<html lang="he" dir="rtl"><head><meta charset="utf-8">' +
    `<title>${title}</title><style>${STYLES}</style></head><body>` +
    innerHtml +
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
