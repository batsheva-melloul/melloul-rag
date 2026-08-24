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
      "צור בוחן אמריקאי של 6 שאלות על הנושא שבשאלה, לפי המסמכים בלבד. לכל שאלה 3 " +
      "אפשרויות שבדיוק אחת מהן נכונה. החזר JSON תקין (ותו לא) בתוך בלוק ```quiz, " +
      "במבנה מדויק:\n" +
      '[{"q":"<השאלה>","options":["<אפשרות א>","<אפשרות ב>","<אפשרות ג>"],"correct":<מספר האינדקס של התשובה הנכונה, 0 עד 2>}]\n' +
      "אל תכתוב שום טקסט מחוץ לבלוק, ואל תסמן בטקסט האפשרויות מי הנכונה (רק דרך השדה " +
      "correct). אם אין במסמכים מספיק מידע על הנושא, אל תייצר בוחן — אמור בפשטות שאין " +
      "מידע על כך במסמכים.",
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
