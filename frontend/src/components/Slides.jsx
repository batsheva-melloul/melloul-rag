// Renders a ```slides block (the "מצגת" template's output) as a readable preview:
// one card per slide with its title and bullets. The same content is what the
// "📊 הורד כמצגת" button turns into a designed .pptx.

function parseDeck(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const data = JSON.parse(raw.slice(start, end + 1));
    if (data && Array.isArray(data.slides)) return data;
  } catch {
    /* not valid JSON — fall back to raw text */
  }
  return null;
}

function Slides({ text }) {
  const deck = parseDeck(text);
  // If it isn't valid slide JSON, show the text as-is rather than a broken preview.
  if (!deck) return <pre>{text}</pre>;

  return (
    <div className="slides-preview">
      {deck.title && <div className="slides-deck-title">🎬 {deck.title}</div>}
      {deck.slides.map((s, i) => (
        <div className="slide-card" key={i}>
          <span className="slide-card-num">{i + 1}</span>
          <div className="slide-card-body">
            {s.title && <div className="slide-card-title">{s.title}</div>}
            {Array.isArray(s.bullets) && s.bullets.length > 0 && (
              <ul>
                {s.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default Slides;
