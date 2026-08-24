import { useState } from "react";

// Renders a ```quiz block as an interactive multiple-choice quiz. The model returns
// a JSON array: [{ q, options: [3], correct: <index> }, ...]. The user picks an
// option, immediately sees right/wrong (and the correct one), and a running score.

function parseQuiz(text) {
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    const json = start >= 0 && end > start ? text.slice(start, end + 1) : text;
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (q) => q && q.q && Array.isArray(q.options) && q.options.length >= 2 &&
        Number.isInteger(q.correct) && q.correct < q.options.length
    );
  } catch {
    return [];
  }
}

function Quiz({ text }) {
  const [questions] = useState(() => parseQuiz(text));
  const [answers, setAnswers] = useState({}); // questionIndex -> chosen option index

  if (!questions.length) return null;

  const answeredCount = Object.keys(answers).length;
  const allAnswered = answeredCount === questions.length;
  const score = questions.reduce(
    (sum, q, i) => sum + (answers[i] === q.correct ? 1 : 0),
    0
  );

  function choose(qi, oi) {
    if (answers[qi] !== undefined) return; // lock a question once answered
    setAnswers((a) => ({ ...a, [qi]: oi }));
  }

  return (
    <div className="quiz">
      {questions.map((q, qi) => {
        const chosen = answers[qi];
        const answered = chosen !== undefined;
        return (
          <div className="quiz-q" key={qi}>
            <div className="quiz-q-text">{qi + 1}. {q.q}</div>
            <div className="quiz-options">
              {q.options.map((opt, oi) => {
                let cls = "quiz-option";
                if (answered && oi === q.correct) cls += " correct";
                else if (answered && oi === chosen) cls += " wrong";
                return (
                  <button
                    key={oi}
                    type="button"
                    className={cls}
                    onClick={() => choose(qi, oi)}
                    disabled={answered}
                  >
                    <span>{opt}</span>
                    {answered && oi === q.correct && <span className="quiz-mark">✓</span>}
                    {answered && oi === chosen && oi !== q.correct && (
                      <span className="quiz-mark">✗</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className={`quiz-score${allAnswered ? " done" : ""}`}>
        ציון: {score} / {questions.length}
        {allAnswered && score === questions.length ? " 🎉" : ""}
        {answeredCount > 0 && (
          <button
            type="button"
            className="quiz-reset"
            onClick={() => setAnswers({})}
          >
            התחל מחדש
          </button>
        )}
      </div>
    </div>
  );
}

export default Quiz;
