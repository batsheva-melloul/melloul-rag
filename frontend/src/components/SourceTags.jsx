import { useState } from "react";

// Collapsible list of the document sources an answer is based on.
// Each source is clickable: it opens the ORIGINAL excerpt the answer drew from,
// with the words shared with the answer highlighted — so the user can see
// exactly which sentence the answer came from.

// Common words that shouldn't be highlighted (Hebrew + English).
const STOPWORDS = new Set([
  "של", "על", "עם", "הוא", "היא", "את", "אם", "כי", "אבל", "או", "גם", "זה",
  "זאת", "יש", "אין", "איך", "למה", "כמה", "מי", "היה", "הם", "הן", "לא", "כן",
  "אשר", "אלא", "לפי", "אינו", "אינם", "המידע", "כך", "כדי", "הזה", "בין", "עוד",
  "שבו", "וכן", "אלה", "אלו", "כמו", "מתוך", "אצל", "אותו", "אותה", "ועל",
  "the", "and", "for", "that", "this", "with", "what", "how", "are", "was",
]);

// Significant words from the answer (length >= 4, minus stopwords) — these are
// what we highlight inside each excerpt.
function answerTerms(answer) {
  if (!answer) return [];
  const words = answer.match(/[^\W\d_]{4,}/gu) || [];
  const terms = new Set();
  for (const w of words) {
    if (!STOPWORDS.has(w.toLowerCase())) terms.add(w);
  }
  return [...terms];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wrap every occurrence of a term inside the excerpt in <mark>. Returns an array
// of strings and <mark> elements (no dangerouslySetInnerHTML — safe).
function highlight(text, terms) {
  if (!terms.length) return text;
  const re = new RegExp("(" + terms.map(escapeRegExp).join("|") + ")", "gu");
  // split() with ONE capturing group => odd indices are the matched terms.
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? <mark key={i}>{part}</mark> : part
  );
}

function SourceTags({ sources, answer }) {
  const [open, setOpen] = useState(false);
  const [openExcerpt, setOpenExcerpt] = useState(null); // index of the open excerpt

  if (!sources || sources.length === 0) {
    return null;
  }

  const terms = answerTerms(answer);

  return (
    <div className="sources">
      <button
        className="sources-toggle"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span className={`sources-arrow ${open ? "open" : ""}`}>▶</span>
        מקורות ({sources.length})
      </button>

      {open && (
        <div className="sources-list">
          {sources.map((src, index) => {
            const isOpen = openExcerpt === index;
            return (
              <div key={index} className="source-item">
                <button
                  className="source-tag"
                  onClick={() => setOpenExcerpt(isOpen ? null : index)}
                  aria-expanded={isOpen}
                  title="הצג את הקטע המקורי"
                >
                  📄 {src.source} · עמוד {src.page_number}
                  <span className={`source-arrow ${isOpen ? "open" : ""}`}>▾</span>
                </button>

                {isOpen && src.text && (
                  <blockquote className="source-excerpt">
                    {highlight(src.text, terms)}
                  </blockquote>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default SourceTags;