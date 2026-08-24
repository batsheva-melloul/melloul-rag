// Preset "template" buttons (NotebookLM-style). Picking one turns on a mode; the
// user types only the TOPIC. The topic is sent as the question (so search matches
// the topic), and `directive` is sent separately to shape the answer's FORMAT —
// it is kept OUT of retrieval on purpose. Output stays grounded ONLY in the docs;
// each directive tells the model to say "no info" (not force the format) when the
// documents don't cover the topic.
export const TEMPLATES = [
  {
    id: "study_guide",
    label: "מדריך למידה",
    icon: "📘",
    directive:
      "בנה מדריך למידה מסודר על הנושא שבשאלה, לפי המסמכים בלבד — כלול מושגי מפתח, " +
      "הרעיונות המרכזיים, ונקודות חשובות לזכירה. אם אין במסמכים מספיק מידע על הנושא, " +
      "אל תמציא — אמור בפשטות שאין מספיק מידע על כך במסמכים.",
  },
  {
    id: "quiz",
    label: "בוחן",
    icon: "📝",
    directive:
      "צור בוחן של 8 שאלות על הנושא שבשאלה, לפי המסמכים בלבד. הצג כל שאלה ומתחתיה את " +
      "התשובה הנכונה. אם אין במסמכים מספיק מידע על הנושא, אל תמציא שאלות — אמור בפשטות " +
      "שאין מספיק מידע על כך במסמכים.",
  },
  {
    id: "flashcards",
    label: "כרטיסיות",
    icon: "🗂️",
    directive:
      "צור כרטיסיות לימוד על הנושא שבשאלה, לפי המסמכים בלבד. החזר אותן בתוך בלוק " +
      "```flashcards, כל כרטיסייה בשתי שורות בדיוק בפורמט:\nQ: <שאלה או מושג>\n" +
      "A: <תשובה או הסבר קצר>\nעם שורה ריקה בין כרטיסייה לכרטיסייה. אם אין במסמכים " +
      "מספיק מידע על הנושא, אל תייצר כרטיסיות — אמור בפשטות שאין מידע על כך במסמכים.",
  },
  {
    id: "summary",
    label: "תקציר",
    icon: "📄",
    directive:
      "כתוב תקציר תמציתי וברור על הנושא שבשאלה, לפי המסמכים בלבד. אם אין מספיק מידע " +
      "על כך במסמכים, אמור זאת בפשטות.",
  },
];
