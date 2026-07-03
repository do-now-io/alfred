import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  MdHome, MdCheckBox, MdStickyNote2,
  MdAutoAwesome, MdSettings, MdSearch, MdNotifications, MdHub,
} from "react-icons/md";
import alfredLogo from "./assets/alfred-logo.png";
import Dashboard from "./screens/Dashboard";
import Notes from "./screens/Notes";
import Tasks from "./screens/Tasks";
import Graph from "./screens/Graph";
import Settings from "./screens/Settings";
import AIActions from "./screens/AIActions";
import Placeholder from "./screens/Placeholder";
import Onboarding from "./screens/Onboarding";
import { useRecordingStore } from "./store/recordingStore";
import { useNotesStore } from "./store/notesStore";
import RecordingBar from "./components/RecordingBar";

// ─── Logo ─────────────────────────────────────────────────────────────────────

function AlfredLogo() {
  return (
    <div style={{ padding: "20px 20px 16px", display: "flex", justifyContent: "center" }}>
      <img
        src={alfredLogo}
        alt="Alfred"
        style={{ width: 132, height: "auto", borderRadius: 20, display: "block" }}
      />
    </div>
  );
}

// ─── Nav item ─────────────────────────────────────────────────────────────────

function NavItem({ to, icon, label, end = false }: { to: string; icon: React.ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      style={({ isActive }) => ({
        display: "flex", alignItems: "center", gap: 10,
        padding: "9px 16px", borderRadius: 10, margin: "1px 8px",
        textDecoration: "none", cursor: "pointer",
        background: isActive ? "var(--active-bg)" : "transparent",
        color: isActive ? "var(--accent)" : "var(--text-secondary)",
        fontWeight: isActive ? 500 : 400,
        fontSize: 14,
        transition: "background 0.15s",
      })}
    >
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, fontSize: 18 }}>{icon}</span>
      {label}
    </NavLink>
  );
}

// ─── Recents ──────────────────────────────────────────────────────────────────
// The 5 most recently *modified* notes — ordered by file mtime, which advances on
// save/edit but never on a plain view, so merely opening a note won't reorder it.

function Recents() {
  const navigate = useNavigate();
  const recents = useNotesStore(s => s.recents);
  const selectedPath = useNotesStore(s => s.selectedFile?.path ?? null);
  const fetchRecents = useNotesStore(s => s.fetchRecents);
  const selectFile = useNotesStore(s => s.selectFile);

  useEffect(() => {
    fetchRecents();
    let unsub: (() => void) | undefined;
    listen("notes-updated", () => fetchRecents()).then(fn => { unsub = fn; });
    return () => unsub?.();
  }, [fetchRecents]);

  if (recents.length === 0) return null;

  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ padding: "8px 24px 6px", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-muted)", textTransform: "uppercase" }}>
        Récents
      </div>
      {recents.map((item) => {
        const active = item.path === selectedPath;
        return (
          <div key={item.path} style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "7px 24px", cursor: "pointer", fontSize: 13,
            color: "var(--text-secondary)",
            background: active ? "var(--active-bg)" : "transparent",
          }}
            onClick={() => { selectFile(item.path); navigate("/notes"); }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--active-bg)")}
            onMouseLeave={e => (e.currentTarget.style.background = active ? "var(--active-bg)" : "transparent")}
          >
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.title}>
              {item.title}
            </span>
            {active && (
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar() {
  return (
    <aside style={{
      width: 240, minWidth: 240,
      background: "var(--sidebar-bg)",
      borderRight: "1px solid var(--border)",
      display: "flex", flexDirection: "column",
      height: "100%",
    }}>
      <AlfredLogo />

      <nav style={{ flex: 1, overflowY: "auto", paddingBottom: 8 }}>
        <NavItem to="/" icon={<MdHome />} label="Aujourd'hui" end />
        <NavItem to="/tasks" icon={<MdCheckBox />} label="Tâches" />
        <NavItem to="/notes" icon={<MdStickyNote2 />} label="Notes" />
        <NavItem to="/graph" icon={<MdHub />} label="Graphe" />
        <NavItem to="/ai-actions" icon={<MdAutoAwesome />} label="Alfred" />

        <div style={{ height: 1, background: "var(--border)", margin: "12px 16px" }} />
        <Recents />
      </nav>

      <div style={{ borderTop: "1px solid var(--border)", padding: "8px" }}>
        <NavItem to="/settings" icon={<MdSettings />} label="Paramètres" />
      </div>
    </aside>
  );
}

// ─── Topbar ───────────────────────────────────────────────────────────────────

function Topbar() {
  const [query, setQuery] = useState("");

  return (
    <div style={{
      height: 52, display: "flex", alignItems: "center", gap: 16,
      padding: "0 24px",
      borderBottom: "1px solid var(--border)",
      background: "var(--card-bg)",
      flexShrink: 0,
    }}>
      <div style={{
        flex: 1, display: "flex", alignItems: "center", gap: 8,
        background: "var(--bg)", border: "1px solid var(--border)",
        borderRadius: 8, padding: "6px 12px",
      }}>
        <MdSearch style={{ color: "var(--text-muted)", fontSize: 16, flexShrink: 0 }} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Rechercher dans mes notes, réunions, tâches..."
          style={{
            flex: 1, border: "none", outline: "none", background: "transparent",
            fontSize: 13, color: "var(--text-primary)",
          }}
        />
        <span style={{ fontSize: 11, color: "var(--text-muted)", background: "var(--border)", padding: "2px 6px", borderRadius: 4 }}>
          ⌘K
        </span>
      </div>

      <RecordingBar />

      <button style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "var(--text-secondary)", padding: 4, display: "flex", alignItems: "center" }}>
        <MdNotifications />
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <div style={{
          width: 30, height: 30, borderRadius: "50%",
          background: "#1C1C1C", border: "1.5px solid var(--accent)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 13, color: "var(--accent)",
        }}>A</div>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>Alfred</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>▾</span>
      </div>
    </div>
  );
}

// ─── Main layout ──────────────────────────────────────────────────────────────

function AppInner() {
  const setStatus = useRecordingStore((s) => s.setStatus);

  useEffect(() => {
    const unsubs: (() => void)[] = [];

    listen<{ status: string; duration_seconds: number }>("recording-status-changed", (e) => {
      setStatus(e.payload.status as Parameters<typeof setStatus>[0], e.payload.duration_seconds);
    }).then(fn => unsubs.push(fn));

    listen<{ recording_id: string; transcription_id: string }>("transcription-complete", (_e) => {
      setStatus("idle", 0);
    }).then(fn => unsubs.push(fn));

    return () => unsubs.forEach(fn => fn());
  }, [setStatus]);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Topbar />
        <main style={{ flex: 1, overflow: "auto" }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/graph" element={<Graph />} />
            <Route path="/meetings" element={<Placeholder title="Réunions" />} />
            <Route path="/calendar" element={<Placeholder title="Calendrier" />} />
            <Route path="/ai-actions" element={<AIActions />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  // `null` = still checking; gates the first paint so we don't flash the app
  // before deciding whether onboarding is needed.
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  // Escape hatch: "Revoir l'introduction" (Settings) sets this so the wizard can
  // be replayed even on a fully-configured install, without mutating persisted
  // config. Session-scoped, so it clears when the app quits.
  const forceOnboarding = sessionStorage.getItem("alfred_force_onboarding") === "1";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [done, vault] = await Promise.all([
          invoke<string | null>("get_config", { key: "onboarding_completed" }),
          invoke<string | null>("get_vault_path"),
        ]);
        // Existing installs that already have a vault are treated as onboarded,
        // so the wizard only appears on a genuinely fresh setup.
        if (!cancelled) setOnboarded(done === "true" || !!(vault && vault.length > 0));
      } catch {
        if (!cancelled) setOnboarded(true); // fail open — never trap the user
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const finishOnboarding = () => {
    sessionStorage.removeItem("alfred_force_onboarding");
    setOnboarded(true);
  };

  if (forceOnboarding) {
    return <Onboarding onDone={finishOnboarding} />;
  }

  if (onboarded === null) {
    return <div style={{ height: "100%", background: "var(--bg)" }} />;
  }

  if (!onboarded) {
    return <Onboarding onDone={finishOnboarding} />;
  }

  return (
    <BrowserRouter>
      <AppInner />
    </BrowserRouter>
  );
}
