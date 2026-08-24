import { useState } from "react";

// Renders a ```flashcards block as interactive flip cards. The model returns cards
// as "Q: ...\nA: ..." pairs separated by blank lines; clicking a card flips it.

function parseCards(text) {
  const cards = [];
  for (const block of text.split(/\n\s*\n/)) {
    const q = /Q:\s*(.*)/.exec(block)?.[1]?.trim();
    const a = /A:\s*([\s\S]*)/.exec(block)?.[1]?.trim();
    if (q && a) cards.push({ q, a });
  }
  return cards;
}

function FlashCard({ q, a }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <button
      type="button"
      className={`flashcard${flipped ? " flipped" : ""}`}
      onClick={() => setFlipped((f) => !f)}
    >
      <span className="flashcard-label">{flipped ? "תשובה" : "שאלה"}</span>
      <span className="flashcard-text">{flipped ? a : q}</span>
      <span className="flashcard-hint">
        {flipped ? "לחצו לשאלה ↺" : "לחצו לתשובה ↻"}
      </span>
    </button>
  );
}

function FlashCards({ text }) {
  const cards = parseCards(text);
  if (!cards.length) return null;
  return (
    <div className="flashcards">
      {cards.map((c, i) => (
        <FlashCard key={i} q={c.q} a={c.a} />
      ))}
    </div>
  );
}

export default FlashCards;
