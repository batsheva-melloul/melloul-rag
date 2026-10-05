import { useState, useEffect, useCallback, useRef } from "react";
import { useMsal } from "@azure/msal-react";
import { getAccessToken } from "../auth/getToken";
import {
  fetchAdminOverview,
  fetchAdminQuestions,
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

function StatTile({ label, value, hint }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
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
  if (run.status === "error") {
    return (
      <span className="sync-state error" title={run.error || ""}>
        ! נכשל {timeAgo(run.finishedAt || run.startedAt)}
        {run.error ? ` — ${run.error.slice(0, 80)}` : ""}
      </span>
    );
  }
  return (
    <span className="sync-state ok" title={fmtDateTime(run.finishedAt)}>
      ✓ {timeAgo(run.finishedAt)} · {fmtNumber(run.indexed)} חדשים/עודכנו, {fmtNumber(run.skipped)} ללא שינוי
    </span>
  );
}

function AdminPanel({ corpora }) {
  const { instance, accounts } = useMsal();
  const [days, setDays] = useState(7);
  const [overview, setOverview] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [filter, setFilter] = useState({ corpusId: "", status: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const token = useCallback(() => getAccessToken(instance, accounts), [instance, accounts]);

  const load = useCallback(async () => {
    setError("");
    try {
      const t = await token();
      const [ov, qs] = await Promise.all([
        fetchAdminOverview(days, t),
        fetchAdminQuestions({ limit: 100, corpusId: filter.corpusId, status: filter.status }, t),
      ]);
      setOverview(ov);
      setQuestions(qs);
    } catch (e) {
      setError("לא ניתן לטעון את נתוני הניהול. ייתכן שאין לך הרשאת ניהול.");
    }
  }, [days, filter.corpusId, filter.status, token]);

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

  const usage = overview?.usage?.total;
  const noInfoPct =
    usage && usage.questions ? Math.round((usage.no_info / usage.questions) * 100) : 0;
  const corpusName = (id) => corpora.find((c) => c.id === id)?.name || id;

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
        <StatTile label={`שאלות ב-${days} הימים האחרונים`} value={fmtNumber(usage?.questions)} />
        <StatTile
          label="ללא תשובה במסמכים"
          value={fmtNumber(usage?.no_info)}
          hint={usage?.questions ? `${noInfoPct}% מהשאלות` : ""}
        />
        <StatTile label="שגיאות" value={fmtNumber(usage?.errors)} />
        <StatTile label="משתמשים פעילים" value={fmtNumber(usage?.active_users)} />
        <StatTile label="זמן תשובה ממוצע" value={fmtSeconds(usage?.avg_latency_ms)} />
      </section>

      <section className="admin-section">
        <h3>מאגרים</h3>
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
                      {fmtNumber(pc?.questions || 0)}
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

      <section className="admin-section">
        <div className="section-head">
          <h3>שאלות אחרונות</h3>
          <div className="admin-controls">
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
              {questions.length === 0 && (
                <tr><td colSpan="7" className="muted">אין שאלות להצגה.</td></tr>
              )}
              {questions.map((q, i) => {
                const st = STATUS_LABEL[q.status] || { icon: "", text: q.status };
                return (
                  <tr key={i}>
                    <td className="nowrap" title={fmtDateTime(q.ts)}>{timeAgo(q.ts)}</td>
                    <td className="nowrap">{q.user || "—"}</td>
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

      <StorageSection storage={overview?.storage} />

      {overview && (
        <div className="muted small admin-foot">
          אחסון היסטוריה: {overview.historyBackend === "postgres" ? "Postgres" : "SQLite (מקומי)"}
        </div>
      )}
    </div>
  );
}

export default AdminPanel;
