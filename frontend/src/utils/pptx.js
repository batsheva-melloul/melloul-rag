// Turn an existing answer into a real PowerPoint (.pptx) — entirely in the browser,
// with NO extra model call. The answer's Markdown (or a flashcards/quiz block) is
// parsed into slides; pptxgenjs builds the file and the browser downloads it.
//
// pptxgenjs is imported DYNAMICALLY (only when the user clicks), so it doesn't
// weigh down the app's initial load.

const NAVY = "1F2430";
const BLUE = "466493";
const ACCENT = "5B7FB0";
const LIGHT = "EEF1F6";
const MAX_BULLETS = 7; // per slide, before spilling onto a continuation slide

// Strip Markdown inline markup down to plain text for a slide.
function plain(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

function fence(text, lang) {
  const m = new RegExp("```" + lang + "\\s*([\\s\\S]*?)```").exec(text || "");
  return m ? m[1].trim() : null;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// --- Parse the answer into { title, bullets[] } content slides ---

function slidesFromMarkdown(text) {
  const clean = String(text || "").replace(/```[\s\S]*?```/g, ""); // drop any code fences
  const slides = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.title || cur.bullets.length)) slides.push(cur);
  };
  for (const raw of clean.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    // A heading (# .. ######) or a lone **bold line** starts a new slide.
    const h = /^#{1,6}\s+(.*)$/.exec(t) || /^\*\*(.+?)\*\*:?\s*$/.exec(t);
    if (h) {
      flush();
      cur = { title: plain(h[1]), bullets: [] };
      continue;
    }
    const bullet = t.replace(/^([-*+]|\d+[.)])\s+/, "");
    if (!cur) cur = { title: "", bullets: [] };
    cur.bullets.push(plain(bullet));
  }
  flush();
  return slides;
}

function slidesFromFlashcards(block) {
  const slides = [];
  for (const part of block.split(/\n\s*\n/)) {
    const q = /Q:\s*(.*)/.exec(part)?.[1]?.trim();
    const a = /A:\s*([\s\S]*)/.exec(part)?.[1]?.trim();
    if (q && a) slides.push({ title: plain(q), bullets: [plain(a)] });
  }
  return slides;
}

function slidesFromQuiz(block) {
  let data;
  try {
    data = JSON.parse(block.slice(block.indexOf("["), block.lastIndexOf("]") + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.map((q, i) => ({
    title: `${i + 1}. ${plain(q.q || "")}`,
    bullets: (q.options || []).map(
      (o, oi) => (oi === q.correct ? "✓ " : "") + plain(o)
    ),
  }));
}

function parseSlides(rawText) {
  const fc = fence(rawText, "flashcards");
  if (fc) return slidesFromFlashcards(fc);
  const qz = fence(rawText, "quiz");
  if (qz) return slidesFromQuiz(qz);
  return slidesFromMarkdown(rawText);
}

// Exposed for testing: the exact content slides that the .pptx will contain
// (before the title/sources slides are added).
export function buildContentSlides(rawText) {
  return splitLong(parseSlides(rawText));
}

// Split any slide with too many bullets into "(המשך)" continuation slides.
function splitLong(slides) {
  const out = [];
  for (const s of slides) {
    if (s.bullets.length <= MAX_BULLETS) {
      out.push(s);
      continue;
    }
    chunk(s.bullets, MAX_BULLETS).forEach((part, i) => {
      out.push({ title: i === 0 ? s.title : `${s.title} (המשך)`, bullets: part });
    });
  }
  return out;
}

function safeFileName(name) {
  const clean = String(name).replace(/[\\/:*?"<>|\n\r]+/g, " ").trim();
  return clean.slice(0, 50) || "מצגת";
}

const RTL = { align: "right", rtlMode: true, fontFace: "Arial" };

/**
 * Build and download a .pptx from an existing answer.
 * opts: { question, rawText, books, sources }
 */
export async function downloadPptx(opts) {
  const { question = "", rawText = "", books = [], sources = [] } = opts;

  let content = splitLong(parseSlides(rawText));
  if (!content.length) {
    // Nothing parsed (very short prose) — put the whole answer on one slide.
    content = [{ title: "", bullets: [plain(rawText)].filter(Boolean) }];
  }

  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.3 x 7.5 in
  const W = 13.3;

  // --- Title slide ---
  const title = pptx.addSlide();
  title.background = { color: "FFFFFF" };
  title.addShape(pptx.ShapeType.rect, { x: 0, y: 3.3, w: W, h: 0.06, fill: { color: ACCENT } });
  title.addText(plain(question) || "מצגת", {
    x: 0.6, y: 2.0, w: W - 1.2, h: 1.2, fontSize: 34, bold: true, color: NAVY, valign: "bottom", ...RTL,
  });
  const subParts = ["עוזר החברה", new Date().toLocaleDateString("he-IL")];
  if (books && books.length) {
    subParts.push(books.map((b) => b.replace(/\.pdf$/i, "")).join(" · "));
  }
  title.addText(subParts.join("  ·  "), {
    x: 0.6, y: 3.5, w: W - 1.2, h: 0.8, fontSize: 14, color: ACCENT, ...RTL,
  });

  // --- Content slides ---
  for (const s of content) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    if (s.title) {
      slide.addText(s.title, {
        x: 0.5, y: 0.35, w: W - 1.0, h: 0.9, fontSize: 24, bold: true, color: BLUE, valign: "top", ...RTL,
      });
    }
    const bullets = (s.bullets.length ? s.bullets : [""]).map((b) => ({
      text: b,
      options: { bullet: { indent: 18 }, breakLine: true, ...RTL },
    }));
    slide.addText(bullets, {
      x: 0.6, y: s.title ? 1.5 : 0.6, w: W - 1.2, h: s.title ? 5.4 : 6.3,
      fontSize: 18, color: NAVY, valign: "top", lineSpacingMultiple: 1.15,
    });
  }

  // --- Sources slide ---
  if (Array.isArray(sources) && sources.length) {
    const slide = pptx.addSlide();
    slide.background = { color: LIGHT };
    slide.addText("מקורות", {
      x: 0.5, y: 0.35, w: W - 1.0, h: 0.9, fontSize: 24, bold: true, color: BLUE, valign: "top", ...RTL,
    });
    const items = sources.slice(0, 12).map((s) => ({
      text: `${s.source} · עמוד ${s.page_number}`,
      options: { bullet: { indent: 18 }, breakLine: true, ...RTL },
    }));
    slide.addText(items, {
      x: 0.6, y: 1.5, w: W - 1.2, h: 5.4, fontSize: 16, color: NAVY, valign: "top", lineSpacingMultiple: 1.2,
    });
  }

  await pptx.writeFile({ fileName: `${safeFileName(question)}.pptx` });
}
