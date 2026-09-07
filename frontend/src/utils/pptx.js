// Turn an existing answer into a real PowerPoint (.pptx) — entirely in the browser,
// with NO extra model call. The answer's Markdown (or a flashcards/quiz block) is
// parsed into slides; pptxgenjs builds the file and the browser downloads it.
//
// pptxgenjs is imported DYNAMICALLY (only when the user clicks), so it doesn't
// weigh down the app's initial load.

const MAX_BULLETS = 6;        // per slide, before spilling onto a continuation slide
const SLIDE_CHAR_BUDGET = 520; // and spill once the text on a slide gets this long

// The chat shows a template question as "📘 מדריך למידה: <topic>". For a slide
// title we want just the topic — drop a leading emoji + label prefix.
function cleanTitle(q) {
  let t = String(q || "").trim();
  if (/^\p{Extended_Pictographic}/u.test(t)) {
    const i = t.indexOf(": ");
    t = i !== -1 ? t.slice(i + 2).trim() : t.replace(/^\p{Extended_Pictographic}+\s*/u, "").trim();
  }
  return t;
}

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

// The "מצגת" template returns a ```slides block: {title, slides:[{title,bullets[]}]}.
// This is the primary, most reliable source — the model already split the deck.
function deckFromJson(rawText) {
  const block = fence(rawText, "slides");
  if (!block) return null;
  let data = null;
  for (const s of [block, block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1)]) {
    try {
      data = JSON.parse(s);
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (!data || !Array.isArray(data.slides)) return null;
  const slides = data.slides
    .map((s) => ({
      title: plain(s.title || ""),
      bullets: (Array.isArray(s.bullets) ? s.bullets : []).map(plain).filter(Boolean),
    }))
    .filter((s) => s.title || s.bullets.length);
  if (!slides.length) return null;
  return { title: plain(data.title || ""), slides };
}

function parseSlides(rawText) {
  const deck = deckFromJson(rawText);
  if (deck) return deck.slides;
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

// Split a slide onto "(המשך)" continuation slides once it has too many bullets OR
// too much text — so a few long paragraphs don't pile into one wall of text.
function splitLong(slides) {
  const out = [];
  for (const s of slides) {
    if (!s.bullets.length) {
      out.push({ title: s.title, bullets: [] });
      continue;
    }
    let cur = [];
    let chars = 0;
    let first = true;
    const flush = () => {
      if (!cur.length) return;
      out.push({ title: first ? s.title : `${s.title} (המשך)`, bullets: cur });
      first = false;
      cur = [];
      chars = 0;
    };
    for (const b of s.bullets) {
      if (cur.length && (chars + b.length > SLIDE_CHAR_BUDGET || cur.length >= MAX_BULLETS)) {
        flush();
      }
      cur.push(b);
      chars += b.length;
    }
    flush();
  }
  return out;
}

function safeFileName(name) {
  const clean = String(name).replace(/[\\/:*?"<>|\n\r]+/g, " ").trim();
  return clean.slice(0, 50) || "מצגת";
}

// LAYOUT_WIDE canvas (inches) and the shared theme geometry.
const W = 13.3;
const H = 7.5;
const STRIPE = 0.22; // width of the accent stripe down the (RTL) right edge

// A palette of hand-picked themes — each a dark "primary" (hero + header bands), a
// lighter "accent" (stripe + kicker), a soft "light" (sources slide), a muted
// footer grey, and a Hebrew-capable font. One is chosen at random per deck, so the
// design differs every time but always stays legible and pleasant.
const THEMES = [
  { primary: "1F3A5F", accent: "6FA8DC", sub: "BBD2EC", light: "EAF1FA", foot: "9AA7BC", font: "Arial" },
  { primary: "22443A", accent: "77BFA3", sub: "BFE0D2", light: "E9F4EF", foot: "93A79D", font: "Segoe UI" },
  { primary: "3E2A4D", accent: "B48CCB", sub: "D8C6E4", light: "F2ECF6", foot: "A498AD", font: "Tahoma" },
  { primary: "5A3A2E", accent: "E0A87E", sub: "EBC9B4", light: "F8EEE7", foot: "AD988C", font: "Times New Roman" },
  { primary: "14484A", accent: "6FC2C4", sub: "B9E0E1", light: "E7F4F4", foot: "8FA6A7", font: "David" },
  { primary: "2C3038", accent: "8FB0D6", sub: "C4CAD4", light: "EEF0F3", foot: "9AA0AB", font: "Arial" },
  { primary: "173A2E", accent: "9CC2A0", sub: "C7E1CA", light: "EAF3EC", foot: "94A79A", font: "Segoe UI" },
  { primary: "4A2F3A", accent: "D390A6", sub: "E7C3D0", light: "F6ECF0", foot: "AD97A0", font: "Georgia" },
];

const BODY = "1F2430";   // dark body text on white content slides
const WHITE = "FFFFFF";

function pickTheme() {
  return THEMES[Math.floor(Math.random() * THEMES.length)];
}

// A vertical accent stripe on the right edge — the theme's signature element.
function addStripe(pptx, slide, t) {
  slide.addShape(pptx.ShapeType.rect, { x: W - STRIPE, y: 0, w: STRIPE, h: H, fill: { color: t.accent } });
}

// A colored header band with the slide title in white.
function addHeader(pptx, slide, t, text) {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W - STRIPE, h: 1.0, fill: { color: t.primary } });
  slide.addText(text || "", {
    x: 0.5, y: 0, w: W - STRIPE - 0.9, h: 1.0, fontSize: 22, bold: true,
    color: WHITE, valign: "middle", align: "right", rtlMode: true, fontFace: t.font,
  });
}

// A quiet footer: brand on the left, slide number on the right.
function addFooter(pptx, slide, t, idx, total) {
  slide.addText("עוזר החברה", {
    x: 0.4, y: H - 0.45, w: 4, h: 0.32, fontSize: 9, color: t.foot, align: "left", fontFace: t.font,
  });
  // Leading LRM keeps "3 / 5" from being visually reversed to "5 / 3" in an RTL deck.
  slide.addText(`‎${idx} / ${total}`, {
    x: W - 2.3, y: H - 0.45, w: 2.3 - STRIPE - 0.15, h: 0.32, fontSize: 9, color: t.foot, align: "right", fontFace: t.font,
  });
}

/**
 * Build and download a designed .pptx from an existing answer.
 * opts: { question, rawText, books, sources }
 */
export async function downloadPptx(opts) {
  const { question = "", rawText = "", books = [], sources = [] } = opts;

  const jsonDeck = deckFromJson(rawText);
  let content = splitLong(parseSlides(rawText));
  if (!content.length) {
    content = [{ title: "", bullets: [plain(rawText)].filter(Boolean) }];
  }

  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.3 x 7.5 in

  const t = pickTheme(); // a fresh look every time
  const rtl = { align: "right", rtlMode: true, fontFace: t.font };
  // Prefer the deck title the model gave; else the (cleaned) question.
  const titleText = (jsonDeck && jsonDeck.title) || cleanTitle(question);
  const total = content.length + 1 + (sources.length ? 1 : 0);
  let n = 0;

  // --- Hero title slide: full themed background ---
  const title = pptx.addSlide();
  title.background = { color: t.primary };
  title.addShape(pptx.ShapeType.rect, { x: W - 0.5, y: 0, w: 0.5, h: H, fill: { color: t.accent } });
  title.addText("מצגת", { x: 0.9, y: 1.7, w: W - 2.2, h: 0.5, fontSize: 16, color: t.sub, ...rtl });
  title.addText(plain(titleText) || "מצגת", {
    x: 0.9, y: 2.2, w: W - 2.2, h: 1.7, fontSize: 40, bold: true, color: WHITE, valign: "top", ...rtl,
  });
  title.addShape(pptx.ShapeType.rect, { x: W - 1.2 - 2.6, y: 3.95, w: 2.6, h: 0.07, fill: { color: t.accent } });
  const subParts = ["עוזר החברה", new Date().toLocaleDateString("he-IL")];
  if (books && books.length) subParts.push(books.map((b) => b.replace(/\.pdf$/i, "")).join(" · "));
  title.addText(subParts.join("  ·  "), {
    x: 0.9, y: 4.2, w: W - 2.2, h: 0.6, fontSize: 14, color: t.sub, ...rtl,
  });

  // --- Content slides ---
  for (const s of content) {
    const slide = pptx.addSlide();
    slide.background = { color: WHITE };
    addStripe(pptx, slide, t);
    if (s.title) addHeader(pptx, slide, t, s.title);
    const bullets = (s.bullets.length ? s.bullets : [""]).map((b) => ({
      text: b,
      options: { bullet: { indent: 20 }, breakLine: true, paraSpaceAfter: 6, ...rtl },
    }));
    const totalChars = s.bullets.reduce((acc, b) => acc + b.length, 0);
    const fontSize = totalChars > 700 ? 14 : totalChars > 400 ? 16 : 19;
    slide.addText(bullets, {
      x: 0.6, y: s.title ? 1.35 : 0.6, w: W - STRIPE - 1.0, h: s.title ? 5.4 : 6.3,
      fontSize, color: BODY, valign: "top", lineSpacingMultiple: 1.18, fontFace: t.font,
    });
    addFooter(pptx, slide, t, (n += 1) + 1, total); // +1: title slide is #1
  }

  // --- Sources slide ---
  if (Array.isArray(sources) && sources.length) {
    const slide = pptx.addSlide();
    slide.background = { color: t.light };
    addStripe(pptx, slide, t);
    addHeader(pptx, slide, t, "מקורות");
    const items = sources.slice(0, 12).map((s) => ({
      text: `${s.source} · עמוד ${s.page_number}`,
      options: { bullet: { indent: 20 }, breakLine: true, paraSpaceAfter: 6, ...rtl },
    }));
    slide.addText(items, {
      x: 0.6, y: 1.35, w: W - STRIPE - 1.0, h: 5.4, fontSize: 15, color: BODY, valign: "top", lineSpacingMultiple: 1.2, fontFace: t.font,
    });
    addFooter(pptx, slide, t, total, total);
  }

  await pptx.writeFile({ fileName: `${safeFileName(titleText)}.pptx` });
}
