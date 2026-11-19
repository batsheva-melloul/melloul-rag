import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { useMsal } from "@azure/msal-react";
import { getAccessToken } from "../auth/getToken";
import {
  fetchAdminOverview,
  fetchAdminQuestions,
  fetchAdminUsers,
  startAdminSync,
  fetchAdminSyncStatus,
} from "../api/chatApi";

// The admin page: usage at a glance, the health of every corpus (documents,
// chunks, last SharePoint sync + a "sync now" button), and the recent question
// log with a filter for questions that got "no info" or an error.
// Everything here is read from /admin/* — the backend decides who is an admin.

const STATUS_LABEL = {
  answered: { icon: "✓", text: "נענתה" },
  no_info: { icon: "∅", text: "אין מידע" },
  error: { icon: "!", text: "שגיאה" },
};

function fmtDateTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
}

function timeAgo(ms) {
  if (!ms) return "מעולם לא";
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `לפני ${hours} שע׳`;
  return `לפני ${Math.round(hours / 24)} ימים`;
}

// "בעוד 5 שע׳" for a future timestamp.
function timeUntil(ms) {
  if (!ms) return "—";
  const minutes = Math.round((ms - Date.now()) / 60000);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `בעוד ${minutes} דק׳`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `בעוד ${hours} שע׳`;
  return `בעוד ${Math.round(hours / 24)} ימים`;
}

// Who started a sync run: the scheduler, the CLI, or an admin (by name).
function triggerLabel(triggerBy) {
  if (!triggerBy) return "";
  if (triggerBy === "schedule") return "אוטומטי";
  if (triggerBy === "cli") return "ידני (CLI)";
  if (triggerBy.startsWith("admin:")) return `ידני · ${triggerBy.slice(6)}`;
  return triggerBy;
}

function fmtNumber(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("he-IL");
}

function fmtSeconds(ms) {
  if (!ms) return "—";
  return `${(ms / 1000).toFixed(1)} שנ׳`;
}

// Bytes as a short human size (KB / MB / GB).
function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// Database storage: total used, and how it splits between documents,
// conversations and the question log. With DB_STORAGE_GB set on the server it
// also shows a meter of used vs. allocated.
function StorageSection({ storage }) {
  if (!storage) return null;
  const pct =
    storage.allocatedBytes && storage.dbBytes
      ? Math.min(100, Math.round((storage.dbBytes / storage.allocatedBytes) * 100))
      : null;
  return (
    <section className="admin-section">
      <h3>אחסון</h3>
      <div className="stat-row">
        <StatTile
          label="גודל מסד הנתונים"
          value={fmtBytes(storage.dbBytes)}
          hint={storage.allocatedBytes ? `מתוך ${fmtBytes(storage.allocatedBytes)} (${pct}%)` : ""}
        />
        <StatTile label="מסמכים (קטעים + אינדקסים)" value={fmtBytes(storage.chunksBytes)} />
        <StatTile
          label="שיחות שמורות"
          value={fmtBytes(storage.conversationsBytes)}
          hint={`${fmtNumber(storage.conversations)} שיחות`}
        />
        <StatTile label="לוג שאלות" value={fmtBytes(storage.questionLogBytes)} />
      </div>
      {pct !== null && (
        <div
          className="meter"
          role="meter"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={pct}
          aria-label="אחוז האחסון התפוס"
        >
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </section>
  );
}

// A KPI tile. With `onClick` it becomes a button that opens its details
// (the people behind "active users", the questions behind a count...).
function StatTile({ label, value, hint, onClick, active, cta }) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
      {onClick && <div className="stat-cta">{cta || "לחצו לפירוט ↓"}</div>}
    </>
  );
  if (!onClick) return <div className="stat-tile">{body}</div>;
  return (
    <button
      type="button"
      className={`stat-tile clickable ${active ? "active" : ""}`}
      onClick={onClick}
      aria-pressed={!!active}
    >
      {body}
    </button>
  );
}

function SyncCell({ run }) {
  if (!run) return <span className="muted">מעולם לא סונכרן</span>;
  if (run.status === "running") {
    return (
      <span className="sync-state running">
        ⏳ מסנכרן… (התחיל {timeAgo(run.startedAt)})
      </span>
    );
  }
  const who = triggerLabel(run.triggerBy);
  if (run.status === "error") {
    return (
      <span className="sync-state error" title={run.error || ""}>
        ! נכשל {timeAgo(run.finishedAt || run.startedAt)}
        {run.error ? ` — ${run.error.slice(0, 80)}` : ""}
        {who && <span className="muted small"> · {who}</span>}
      </span>
    );
  }
  // Files that are in SharePoint but could not be indexed (scanned without a text
  // layer, or over the size limit) and books deleted because they left SharePoint.
  const unreadable = run.unreadable || 0;
  const removed = run.removed || 0;
  return (
    <span className="sync-state ok" title={fmtDateTime(run.finishedAt)}>
      ✓ {timeAgo(run.finishedAt)} · {fmtNumber(run.indexed)} חדשים/עודכנו, {fmtNumber(run.skipped)} ללא שינוי
      {removed > 0 && <>, {fmtNumber(removed)} הוסרו</>}
      {unreadable > 0 && (
        <span className="sync-warn" title="קבצים סרוקים בלי שכבת טקסט או גדולים מדי — לא נכנסו למאגר. יש להעלות גרסה עם OCR.">
          , {fmtNumber(unreadable)} לא נקראו (סרוק / גדול מדי)
        </span>
      )}
      {who && <span className="muted small"> · {who}</span>}
    </span>
  );
}

// One line under the corpora title: is the nightly sync on, and when is the next run.
function ScheduleLine({ schedule }) {
  if (!schedule) return null;
  // Whether a failed night run would be emailed, and to whom (ALERT_EMAIL_TO).
  const mail = schedule.alerts;
  const mailText = !mail
    ? ""
    : mail.enabled
      ? ` · התראה במייל ל-${mail.to.join(", ")}`
      : " · התראות במייל כבויות (ALERT_EMAIL_TO)";
  if (!schedule.enabled) {
    return <span className="muted small">סנכרון אוטומטי כבוי (SYNC_SCHEDULE){mailText}</span>;
  }
  return (
    <span className="muted small" title={fmtDateTime(schedule.nextRunAt)}>
      סנכרון אוטומטי כל יום ב-{schedule.time} · הבא {timeUntil(schedule.nextRunAt)}
      {mailText}
    </span>
  );
}

// The page is one screen: KPI tiles on top, then ONE tabbed detail area right
// under them. A tile click switches to the matching tab with its filter preset
// (no scrolling, nothing to close). The chosen tab is remembered per browser.
const TABS = [
  { id: "questions", label: "שאלות" },
  { id: "users", label: "משתמשים" },
  { id: "corpora", label: "מאגרים" },
  { id: "storage", label: "אחסון" },
];
const TAB_KEY = "rag_admin_tab";

function readSavedTab() {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return TABS.some((x) => x.id === t) ? t : "questions";
  } catch {
    return "questions";
  }
}

function AdminPanel({ corpora }) {
  const { instance, accounts } = useMsal();
  const [days, setDays] = useState(7);
  const [tab, setTab] = useState(readSavedTab);
  const [overview, setOverview] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [users, setUsers] = useState([]);
  // The question log follows the same period as the tiles, so a tile shows
  // exactly the questions it counted. userId/userName narrow it to one person.
  const [filter, setFilter] = useState({ corpusId: "", status: "", userId: "", userName: "" });
  const [sortBy, setSortBy] = useState("ts"); // "ts" (newest) | "latency" (slowest)
  // Users tab: which row is expanded, and that person's recent questions (cached).
  const [expandedUser, setExpandedUser] = useState("");
  const [userQuestions, setUserQuestions] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const token = useCallback(() => getAccessToken(instance, accounts), [instance, accounts]);

  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
  }, [tab]);

  const load = useCallback(async () => {
    setError("");
    try {
      const t = await token();
      const [ov, qs, us] = await Promise.all([
        fetchAdminOverview(days, t),
        fetchAdminQuestions(
          { limit: 200, corpusId: filter.corpusId, status: filter.status, userId: filter.userId, days },
          t,
        ),
        fetchAdminUsers(days, t),
      ]);
      setOverview(ov);
      setQuestions(qs);
      setUsers(us);
      setUserQuestions({}); // period may have changed
    } catch (e) {
      setError("לא ניתן לטעון את נתוני הניהול. ייתכן שאין לך הרשאת ניהול.");
    }
  }, [days, filter.corpusId, filter.status, filter.userId, token]);

  useEffect(() => {
    load();
  }, [load]);

  // While a sync is running, refresh its status every few seconds.
  const running = overview?.runningSync;
  useEffect(() => {
    if (!running) return undefined;
    pollRef.current = setInterval(async () => {
      try {
        const t = await token();
        const status = await fetchAdminSyncStatus(t);
        if (!status.running) {
          clearInterval(pollRef.current);
          load(); // picks up the new document/chunk counts
        } else {
          setOverview((prev) => (prev ? { ...prev, runningSync: status.running } : prev));
        }
      } catch {
        /* keep polling */
      }
    }, 5000);
    return () => clearInterval(pollRef.current);
  }, [running, token, load]);

  async function handleSync(corpusId) {
    setBusy(true);
    setError("");
    try {
      const t = await token();
      await startAdminSync(corpusId, t);
      await load();
    } catch (e) {
      setError(e.message === "409" ? "סנכרון אחר כבר רץ. נסי שוב כשיסתיים." : "הסנכרון לא התחיל.");
    } finally {
      setBusy(false);
    }
  }

  // --- navigation: tiles and in-table links all land in a tab with a preset filter
  function openQuestions({ status = "", corpusId = "", sort = "ts" } = {}) {
    setFilter({ corpusId, status, userId: "", userName: "" });
    setSortBy(sort);
    setTab("questions");
  }
  function openUserQuestions(u) {
    setFilter({ corpusId: "", status: "", userId: u.userId, userName: u.user || u.userId });
    setSortBy("ts");
    setTab("questions");
  }
  const clearUser = () => setFilter((f) => ({ ...f, userId: "", userName: "" }));

  // Users tab: expand a row to see that person's latest questions inline.
  async function toggleUser(u) {
    const id = u.userId;
    if (expandedUser === id) {
      setExpandedUser("");
      return;
    }
    setExpandedUser(id);
    if (!userQuestions[id]) {
      try {
        const t = await token();
        const qs = await fetchAdminQuestions({ userId: id, days, limit: 15 }, t);
        setUserQuestions((prev) => ({ ...prev, [id]: qs }));
      } catch {
        setUserQuestions((prev) => ({ ...prev, [id]: [] }));
      }
    }
  }

  const sortedQuestions =
    sortBy === "latency"
      ? [...questions].sort((a, b) => (b.latencyMs || 0) - (a.latencyMs || 0))
      : questions;

  const usage = overview?.usage?.total;
  const noInfoPct =
    usage && usage.questions ? Math.round((usage.no_info / usage.questions) * 100) : 0;
  const corpusName = (id) => corpora.find((c) => c.id === id)?.name || id;
  const tabCount = {
    questions: usage?.questions,
    users: usage?.active_users,
    corpora: overview?.corpora?.length,
    storage: null,
  };

  return (
    <div className="admin">
      <div className="admin-head">
        <h2>ניהול</h2>
        <div className="admin-controls">
          <div className="seg">
            <button className={days === 7 ? "on" : ""} onClick={() => setDays(7)}>7 ימים</button>
            <button className={days === 30 ? "on" : ""} onClick={() => setDays(30)}>30 ימים</button>
          </div>
          <button className="admin-btn" onClick={load}>רענון</button>
        </div>
      </div>

      {error && <div className="admin-error">{error}</div>}

      <section className="stat-row">
        <StatTile
          label={`שאלות ב-${days} הימים האחרונים`}
          value={fmtNumber(usage?.questions)}
          onClick={() => openQuestions()}
          active={tab === "questions" && !filter.status && !filter.userId && !filter.corpusId && sortBy === "ts"}
          cta="כל השאלות"
        />
        <StatTile
          label="ללא תשובה במסמכים"
          value={fmtNumber(usage?.no_info)}
          hint={usage?.questions ? `${noInfoPct}% מהשאלות` : ""}
          onClick={() => openQuestions({ status: "no_info" })}
          active={tab === "questions" && filter.status === "no_info"}
          cta="אילו שאלות?"
        />
        <StatTile
          label="שגיאות"
          value={fmtNumber(usage?.errors)}
          onClick={() => openQuestions({ status: "error" })}
          active={tab === "questions" && filter.status === "error"}
          cta="אילו שאלות?"
        />
        <StatTile
          label="משתמשים פעילים"
          value={fmtNumber(usage?.active_users)}
          onClick={() => setTab("users")}
          active={tab === "users"}
          cta="מי?"
        />
        <StatTile
          label="זמן תשובה ממוצע"
          value={fmtSeconds(usage?.avg_latency_ms)}
          onClick={() => openQuestions({ sort: "latency" })}
          active={tab === "questions" && sortBy === "latency"}
          cta="האיטיות ביותר"
        />
      </section>

      <nav className="tabs" role="tablist" aria-label="פירוט">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "on" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {tabCount[t.id] !== null && tabCount[t.id] !== undefined && (
              <span className="tab-count">{fmtNumber(tabCount[t.id])}</span>
            )}
            {t.id === "corpora" && running && <span className="tab-dot" title="סנכרון רץ" />}
          </button>
        ))}
      </nav>

      {tab === "questions" && (
        <section className="admin-section tab-panel">
          <div className="section-head">
            <h3>שאלות ב-{days} הימים האחרונים</h3>
            <div className="admin-controls">
              {filter.userId && (
                <button className="filter-chip" onClick={clearUser} title="הסר את סינון המשתמש">
                  משתמש: {filter.userName} ✕
                </button>
              )}
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} title="מיון">
                <option value="ts">החדשות קודם</option>
                <option value="latency">האיטיות קודם</option>
              </select>
              <select
                value={filter.corpusId}
                onChange={(e) => setFilter((f) => ({ ...f, corpusId: e.target.value }))}
              >
                <option value="">כל המאגרים</option>
                {corpora.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <select
                value={filter.status}
                onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}
              >
                <option value="">כל הסטטוסים</option>
                <option value="no_info">רק ללא מידע</option>
                <option value="error">רק שגיאות</option>
                <option value="answered">רק שנענו</option>
              </select>
            </div>
          </div>
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>מתי</th>
                  <th>מי</th>
                  <th>מאגר</th>
                  <th>שאלה</th>
                  <th>סטטוס</th>
                  <th>מקורות</th>
                  <th>זמן</th>
                </tr>
              </thead>
              <tbody>
                {sortedQuestions.length === 0 && (
                  <tr><td colSpan="7" className="muted">אין שאלות להצגה.</td></tr>
                )}
                {sortedQuestions.map((q, i) => {
                  const st = STATUS_LABEL[q.status] || { icon: "", text: q.status };
                  return (
                    <tr key={i}>
                      <td className="nowrap" title={fmtDateTime(q.ts)}>{timeAgo(q.ts)}</td>
                      <td className="nowrap">
                        {q.userId ? (
                          <button
                            className="link-btn"
                            onClick={() => openUserQuestions({ userId: q.userId, user: q.user })}
                            title="רק השאלות של המשתמש הזה"
                          >
                            {q.user || "—"}
                          </button>
                        ) : (q.user || "—")}
                      </td>
                      <td className="nowrap">{corpusName(q.corpusId)}</td>
                      <td className="q-text" title={q.question}>{q.question}</td>
                      <td className={`status ${q.status}`}><span className="status-icon">{st.icon}</span> {st.text}</td>
                      <td className="num">{fmtNumber(q.sources)}{q.wholeBook ? " 📚" : ""}</td>
                      <td className="num">{fmtSeconds(q.latencyMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "users" && (
        <section className="admin-section tab-panel">
          <div className="section-head">
            <h3>משתמשים פעילים ב-{days} הימים האחרונים</h3>
            <span className="muted small">לחיצה על שורה פותחת את השאלות האחרונות של המשתמש</span>
          </div>
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>מי</th>
                  <th>שאלות</th>
                  <th>ללא מידע</th>
                  <th>שגיאות</th>
                  <th>מאגרים</th>
                  <th>זמן ממוצע</th>
                  <th>שאלה אחרונה</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && (
                  <tr><td colSpan="7" className="muted">אין משתמשים בתקופה הזו.</td></tr>
                )}
                {users.map((u) => {
                  const open = expandedUser === u.userId;
                  const qs = userQuestions[u.userId];
                  return (
                    <Fragment key={u.userId}>
                      <tr
                        className={`user-row-btn ${open ? "open" : ""}`}
                        onClick={() => toggleUser(u)}
                        aria-expanded={open}
                      >
                        <td className="nowrap cell-title">
                          <span className={`row-arrow ${open ? "open" : ""}`}>▸</span> {u.user || u.userId}
                        </td>
                        <td className="num">{fmtNumber(u.questions)}</td>
                        <td className="num">{fmtNumber(u.noInfo)}</td>
                        <td className="num">{fmtNumber(u.errors)}</td>
                        <td>{(u.corpora || []).map(corpusName).join(", ") || "—"}</td>
                        <td className="num">{fmtSeconds(u.avgLatencyMs)}</td>
                        <td className="nowrap" title={fmtDateTime(u.lastTs)}>{timeAgo(u.lastTs)}</td>
                      </tr>
                      {open && (
                        <tr className="user-detail">
                          <td colSpan="7">
                            {!qs && <span className="muted small">טוען…</span>}
                            {qs && qs.length === 0 && <span className="muted small">אין שאלות.</span>}
                            {qs && qs.length > 0 && (
                              <ul className="user-questions">
                                {qs.map((q, i) => {
                                  const st = STATUS_LABEL[q.status] || { icon: "", text: q.status };
                                  return (
                                    <li key={i}>
                                      <span className="muted small nowrap" title={fmtDateTime(q.ts)}>{timeAgo(q.ts)}</span>
                                      <span className="muted small nowrap">{corpusName(q.corpusId)}</span>
                                      <span className="uq-text" title={q.question}>{q.question}</span>
                                      <span className={`status ${q.status} small nowrap`}>{st.icon} {st.text}</span>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                            <button className="link-btn small" onClick={() => openUserQuestions(u)}>
                              כל השאלות של {u.user || u.userId} בטבלה המלאה ←
                            </button>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "corpora" && (
        <section className="admin-section tab-panel">
          <div className="section-head">
            <h3>מאגרים</h3>
            <ScheduleLine schedule={overview?.schedule} />
          </div>
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>מאגר</th>
                  <th>מסמכים</th>
                  <th>קטעים</th>
                  <th>שאלות ({days} ימים)</th>
                  <th>סנכרון אחרון</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(overview?.corpora || []).map((c) => {
                  const pc = overview?.usage?.per_corpus?.[c.id];
                  const isRunningHere = running && running.corpusId === c.id;
                  return (
                    <tr key={c.id}>
                      <td>
                        <div className="cell-title">{c.name}</div>
                        <div className="muted small">
                          {c.sitePath}
                          {c.folder ? ` / ${c.folder}` : ""}
                          {c.role ? ` · הרשאה: ${c.role}` : " · פתוח לכולם"}
                        </div>
                      </td>
                      <td className="num">{fmtNumber(c.docs)}</td>
                      <td className="num">{fmtNumber(c.chunks)}</td>
                      <td className="num">
                        {pc?.questions ? (
                          <button
                            className="link-btn"
                            onClick={() => openQuestions({ corpusId: c.id })}
                            title="השאלות של המאגר הזה"
                          >
                            {fmtNumber(pc.questions)}
                          </button>
                        ) : "0"}
                        {pc?.no_info ? <span className="muted small"> ({pc.no_info} ללא מידע)</span> : null}
                      </td>
                      <td>
                        <SyncCell run={isRunningHere ? { ...running, status: "running" } : c.lastSync} />
                      </td>
                      <td>
                        <button
                          className="admin-btn"
                          disabled={busy || !!running}
                          onClick={() => handleSync(c.id)}
                          title={running ? "סנכרון אחר רץ כרגע" : "משוך מסמכים חדשים/מעודכנים מ-SharePoint"}
                        >
                          סנכרן עכשיו
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "storage" && (
        <div className="tab-panel">
          <StorageSection storage={overview?.storage} />
          {overview && (
            <div className="muted small admin-foot">
              אחסון היסטוריה: {overview.historyBackend === "postgres" ? "Postgres" : "SQLite (מקומי)"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AdminPanel;
