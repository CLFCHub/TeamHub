import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const GRADES = [
  { key: "league", label: "LEAGUE", teamId: "046b90e4" },
  { key: "reserves", label: "RESERVES", teamId: "5bf15ff7" },
  { key: "colts", label: "COLTS", teamId: "a95954ed" },
  { key: "thirds", label: "THIRDS", teamId: "696edf4b" },
];

const apiBase =
  import.meta.env.VITE_WORKER_URL ||
  "https://playhq-sync.clfchub.workers.dev";

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

function App() {
  const [grade, setGrade] = useState(null);
  const [adminOpen, setAdminOpen] = useState(false);

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="brand"
          onClick={() => setGrade(null)}
        >
          CLFC HUB
        </button>

        <button
          className="admin-icon"
          aria-label="Admin"
          onClick={() => setAdminOpen(true)}
        >
          ⚙
        </button>
      </header>

      {!grade ? (
        <main className="home">
          <div className="hero">
            <p className="eyebrow">CLUB PLAYER HUB</p>
            <h1>Select your grade</h1>
          </div>

          <div className="grade-grid">
            {GRADES.map((g) => (
              <button
                key={g.key}
                className="grade-card"
                onClick={() => setGrade(g.key)}
              >
                <span>{g.label}</span>
                <small>View team list →</small>
              </button>
            ))}
          </div>
        </main>
      ) : (
        <GradePage
          gradeKey={grade}
          onBack={() => setGrade(null)}
        />
      )}

      {adminOpen && (
        <AdminPanel
          onClose={() => setAdminOpen(false)}
        />
      )}
    </div>
  );
}

function GradePage({ gradeKey, onBack }) {
  const grade = GRADES.find(
    (g) => g.key === gradeKey
  );

  const [players, setPlayers] = useState([]);
  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");

    try {
      const data = await api(
        `/roster?grade=${gradeKey}`
      );

      setPlayers(data.players || []);
      setSource(data.source || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [gradeKey]);

  async function playhq() {
    setBusy(true);
    setError("");

    try {
      const today = new Date()
        .toISOString()
        .slice(0, 10);

      await api(
        `/sync/players?date=${today}`
      );

      await load();

      setSource("playhq");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <button
        className="back"
        onClick={onBack}
      >
        ← Grades
      </button>

      <div className="page-heading">
        <div>
          <p className="eyebrow">TEAM LIST</p>
          <h1>{grade.label}</h1>
        </div>

        <button
          className="playhq"
          onClick={playhq}
          disabled={busy}
        >
          {busy ? "LOADING…" : "PLAYHQ"}
        </button>
      </div>

      {error && (
        <div className="error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="empty">
          Loading…
        </div>
      ) : players.length === 0 ? (
        <div className="empty">
          <strong>There is no list</strong>
          <span>
            No players have been populated for this grade.
          </span>
        </div>
      ) : (
        <section className="roster">
          <div className="roster-meta">
            <span>
              {players.length} players
            </span>

            {source && (
              <span className="source">
                {source.toUpperCase()}
              </span>
            )}
          </div>

          {players.map((player, i) => (
            <div
              className="player"
              key={
                player.playhq_uid ||
                player.id ||
                i
              }
            >
              <span className="number">
                {String(i + 1).padStart(2, "0")}
              </span>

              <span className="player-name">
                {player.name}
              </span>

              {player.pin && (
                <span className="pin">
                  PIN {player.pin}
                </span>
              )}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

function AdminPanel({ onClose }) {
  const [grade, setGrade] = useState("colts");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function action(kind) {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      if (kind === "mock") {
        const data = await api(
          "/mock/roster",
          {
            method: "POST",
            body: JSON.stringify({
              grade,
            }),
          }
        );

        setMessage(
          `Mocked ${
            data.players?.length || 0
          } players into ${grade}.`
        );
      } else if (kind === "clear") {
        const data = await api(
          "/mock/clear",
          {
            method: "POST",
            body: JSON.stringify({
              grade,
            }),
          }
        );

        setMessage(
          `Cleared ${
            data.deleted || 0
          } players from ${grade}.`
        );
      } else if (kind === "deepSync") {
        const data = await api("/sync/members");
        setMessage(data.message || "Deep sync complete.");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <aside className="admin-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">
              CONTROL PANEL
            </p>

            <h2>Admin</h2>
          </div>

          <button
            className="close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="admin-actions">
          <div className="field">
            <label>Select grade</label>

            <select
              value={grade}
              onChange={(e) =>
                setGrade(e.target.value)
              }
            >
              {GRADES.map((g) => (
                <option
                  key={g.key}
                  value={g.key}
                >
                  {g.label}
                </option>
              ))}
            </select>
          </div>

          <div className="actions-grid">
            <button
              onClick={() => action("deepSync")}
              disabled={busy}
              className="primary"
            >
              RUN DEEP SYNC
            </button>

            <button
              onClick={() => action("mock")}
              disabled={busy}
              className="secondary"
            >
              MOCK UP 22 PLAYERS
            </button>

            <button
              onClick={() => action("clear")}
              disabled={busy}
              className="danger"
            >
              CLEAR LIST
            </button>
          </div>

          {message && (
            <div className="success">
              {message}
            </div>
          )}

          {error && (
            <div className="error">
              {error}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <App />
);
