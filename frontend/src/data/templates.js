// Preset "template" prompts (NotebookLM-style). Clicking a template fills the input
// with a ready-made instruction; the user appends the topic (or a book name) and
// sends. The answer is still grounded ONLY in the documents — these just shape the
// FORMAT of the output. Flashcards ask for a ```flashcards block (rendered as
// interactive cards); the rest render as normal Markdown.
export const TEMPLATES = [
  {
    id: "study_guide",
    label: "מדריך למידה",
    icon: "📘",
    prompt:
      "צור מדריך למידה מסודר על הנושא/הספר הבא, לפי המסמכים במאגר — כלול מושגי מפתח, " +
      "הרעיונות המרכזיים, ונקודות חשובות לזכירה. הנושא: ",
  },
  {
    id: "quiz",
    label: "בוחן",
    icon: "📝",
    prompt:
      "צור בוחן של 8 שאלות על הנושא/הספר הבא, לפי המסמכים במאגר. הצג כל שאלה, " +
      "ומתחתיה את התשובה הנכונה. הנושא: ",
  },
  {
    id: "flashcards",
    label: "כרטיסיות",
    icon: "🗂️",
    prompt:
      "צור כרטיסיות לימוד על הנושא/הספר הבא, לפי המסמכים במאגר. החזר אותן בתוך בלוק " +
      "```flashcards, כל כרטיסייה בשתי שורות בדיוק בפורמט:\nQ: <שאלה או מושג>\n" +
      "A: <תשובה או הסבר קצר>\nעם שורה ריקה בין כרטיסייה לכרטיסייה. הנושא: ",
  },
  {
    id: "summary",
    label: "תקציר",
    icon: "📄",
    prompt: "כתוב תקציר תמציתי וברור על הנושא/הספר הבא, לפי המסמכים במאגר: ",
  },
];
