"""
eval.py — offline quality check for the RAG system.

Runs a fixed set of questions (eval_questions.json) through the REAL RagEngine
and reports how well the system did — WITHOUT any human in the loop. This turns
"I think it's good" into "I measured 85% retrieval accuracy", and lets you tell
whether a future change (new model, new chunking, etc.) helped or hurt.

What it checks per question:
  - Retrieval hit  — was the expected source document actually retrieved?
  - Keyword cover  — does the answer contain the expected keywords?
  - "No info"      — do out-of-scope questions correctly return "no info"?

Usage:
    python eval.py                    # uses eval_questions.json
    python eval.py myset.json         # a different question set
    python eval.py --judge            # ALSO ask the LLM to grade each answer
                                      #   (extra API calls — costs/quota apply)

Question format (JSON list); only "question" and "corpus" are required:
    {
      "question": "מהי חרדה אצל קירקגור?",
      "corpus": "magar",
      "expect": "answer",                      # "answer" (default) or "no_info"
      "expected_source": "kierkegaard.pdf",    # optional — checked vs retrieved sources
      "expected_keywords": ["חרדה", "חופש"]    # optional — should appear in the answer
    }
"""

import sys
import json
import time
import logging

# Hebrew prints correctly on the Windows console.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from log_config import setup_logging
from rag_core import RagEngine, NO_INFO_MESSAGE, build_context_block

QUESTIONS_FILE = "eval_questions.json"

# Phrases that mean "the answer is not in the documents" (loose match — the model
# may phrase it slightly differently than the exact NO_INFO_MESSAGE).
_NO_INFO_HINTS = [
    NO_INFO_MESSAGE,
    "אין לי מידע",
    "אינו מופיע",       # "המידע ... אינו מופיע בקטעי המסמכים"
    "אינו נמצא",        # "המידע ... אינו נמצא במסמכים שברשותי"
    "אינם מופיעים",
    "אינם נמצאים",
    "לא מופיע",
    "לא נמצא",
    "לא מצאתי",
    "לא ניתן לענות",    # gpt-5: "... ולכן לא ניתן לענות על השאלה"
    "אין במסמכים",
    "אין במקטעים",      # gpt-5: "אין במקטעים שסופקו כל מידע"
    "אין בתמלילים",
    "אין בקטעים",
    "אין במקורות",
    "לא כתוב במסמכים",
]


# ---------------------------------------------------------------------------
# Per-check helpers
# ---------------------------------------------------------------------------

def looks_like_no_info(answer: str) -> bool:
    """True if the answer is some form of 'this isn't in the documents'."""
    return any(hint in answer for hint in _NO_INFO_HINTS)


def source_was_retrieved(expected: str, sources: list[dict]) -> bool:
    """True if the expected source file appears among the retrieved chunks."""
    expected = expected.lower()
    return any(expected in (s.get("source", "").lower()) for s in sources)


def keyword_coverage(keywords: list[str], answer: str) -> tuple[int, int]:
    """Return (found, total) — how many expected keywords appear in the answer."""
    low = answer.lower()
    found = sum(1 for kw in keywords if kw.lower() in low)
    return found, len(keywords)


# ---------------------------------------------------------------------------
# Optional LLM-as-judge (only with --judge)
# ---------------------------------------------------------------------------

_JUDGE_SYSTEM = (
    "You are a strict grader for a grounded Q&A system. You are given a question, "
    "the document excerpts the system retrieved, and the answer it produced. "
    "Grade ONLY on these two things and reply with a single digit 1-5:\n"
    "  5 = answer is fully supported by the excerpts and addresses the question;\n"
    "  3 = partially supported or partially answers;\n"
    "  1 = unsupported, invented, or off-topic.\n"
    "Reply with ONLY the digit, nothing else."
)


def judge_answer(llm, question: str, sources: list[dict], answer: str) -> int | None:
    """Ask the LLM to score the answer 1-5 for grounding. None if it can't be parsed."""
    context = build_context_block(sources) if sources else "(no excerpts retrieved)"
    user = f"Question:\n{question}\n\nRetrieved excerpts:\n{context}\n\nAnswer:\n{answer}"
    try:
        raw = llm.generate(_JUDGE_SYSTEM, [{"role": "user", "text": user}]).strip()
    except Exception as e:
        logging.getLogger("rag.eval").warning("judge failed: %s", e)
        return None
    for ch in raw:
        if ch in "12345":
            return int(ch)
    return None


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def load_questions(path: str) -> list[dict]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"\n  לא נמצא קובץ שאלות: {path}")
        print(f"  העתיקי את eval_questions.example.json ל-{QUESTIONS_FILE} ומלאי שאלות אמיתיות.\n")
        sys.exit(1)


def main() -> None:
    setup_logging()
    # Quiet the per-request noise so the report stays readable.
    logging.getLogger("rag").setLevel(logging.WARNING)

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    use_judge = "--judge" in sys.argv
    path = args[0] if args else QUESTIONS_FILE

    questions = load_questions(path)
    engines: dict[str, RagEngine] = {}   # one RagEngine per corpus, built lazily

    # Tallies (each metric counts only the questions that opted into it).
    retrieval_hits = retrieval_total = 0
    keyword_found = keyword_total = 0
    noinfo_ok = noinfo_total = 0
    judge_scores: list[int] = []
    errors = 0

    print(f"\n=== הרצת הערכה: {len(questions)} שאלות ({path}) ===\n")

    for i, q in enumerate(questions, start=1):
        question = q["question"]
        corpus_id = q.get("corpus", "magar")
        expect = q.get("expect", "answer")

        if corpus_id not in engines:
            engines[corpus_id] = RagEngine(corpus_id)
        engine = engines[corpus_id]

        t0 = time.time()
        try:
            result = engine.answer(question)
        except Exception as e:
            # A single failed call (e.g. a network content-filter block, a rate
            # limit, or a timeout) must not abort the whole run — record it and
            # move on so the rest of the report still gets produced.
            errors += 1
            ms = int((time.time() - t0) * 1000)
            print(f"[{i}/{len(questions)}] ({corpus_id}, {ms}ms) {question}")
            print(f"      שגיאה ✗ ({type(e).__name__}: {str(e)[:120]})\n")
            continue
        ms = int((time.time() - t0) * 1000)

        answer = result["answer"]
        sources = result["sources"]
        flags: list[str] = []

        # --- Check: "no info" questions ---
        if expect == "no_info":
            noinfo_total += 1
            if looks_like_no_info(answer):
                noinfo_ok += 1
                flags.append("no-info ✓")
            else:
                flags.append("no-info ✗ (ענה במקום לומר 'אין מידע')")

        # --- Check: expected source retrieved ---
        expected_source = q.get("expected_source")
        if expected_source:
            retrieval_total += 1
            if source_was_retrieved(expected_source, sources):
                retrieval_hits += 1
                flags.append("source ✓")
            else:
                got = ", ".join(sorted({s["source"] for s in sources})) or "—"
                flags.append(f"source ✗ (ציפינו {expected_source}, קיבלנו: {got})")

        # --- Check: expected keywords present ---
        keywords = q.get("expected_keywords")
        if keywords:
            found, total = keyword_coverage(keywords, answer)
            keyword_found += found
            keyword_total += total
            mark = "✓" if found == total else ("~" if found else "✗")
            flags.append(f"keywords {mark} {found}/{total}")

        # --- Optional LLM judge ---
        if use_judge:
            score = judge_answer(engine.llm, question, sources, answer)
            if score is not None:
                judge_scores.append(score)
                flags.append(f"judge {score}/5")

        print(f"[{i}/{len(questions)}] ({corpus_id}, {ms}ms) {question}")
        print(f"      {' | '.join(flags) if flags else '(אין בדיקות מוגדרות)'}")
        snippet = answer.replace("\n", " ")
        if len(snippet) > 140:
            snippet = snippet[:140] + "…"
        print(f"      → {snippet}\n")

    # --- Summary ---
    print("=" * 60)
    print("סיכום:")
    if retrieval_total:
        pct = 100 * retrieval_hits / retrieval_total
        print(f"  אחזור מקור נכון : {retrieval_hits}/{retrieval_total}  ({pct:.0f}%)")
    if keyword_total:
        pct = 100 * keyword_found / keyword_total
        print(f"  כיסוי מילות מפתח: {keyword_found}/{keyword_total}  ({pct:.0f}%)")
    if noinfo_total:
        pct = 100 * noinfo_ok / noinfo_total
        print(f"  זיהוי 'אין מידע': {noinfo_ok}/{noinfo_total}  ({pct:.0f}%)")
    if judge_scores:
        avg = sum(judge_scores) / len(judge_scores)
        print(f"  ציון שופט LLM   : {avg:.1f}/5  (ממוצע על {len(judge_scores)} שאלות)")
    if errors:
        print(f"  שגיאות (לא נספרו): {errors}/{len(questions)}  (חסימת רשת / מכסה / timeout)")
    if not (retrieval_total or keyword_total or noinfo_total or judge_scores):
        print("  לא הוגדרו בדיקות. הוסיפי expected_source / expected_keywords / expect=no_info.")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()