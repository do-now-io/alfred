import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, useNavigate, useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  MdCheckBox, MdStickyNote2,
  MdAutoAwesome, MdSettings, MdHub, MdMic, MdStop, MdFactCheck, MdCalendarToday,
} from "react-icons/md";
import alfredAvatar from "./assets/alfred-logo.png";
import Dashboard from "./screens/Dashboard";
import Notes from "./screens/Notes";
import Tasks from "./screens/Tasks";
import Agenda from "./screens/Agenda";
import Graph from "./screens/Graph";
import Settings from "./screens/Settings";
import RecordingGuide from "./screens/RecordingGuide";
import Feedback from "./screens/Feedback";
import Onboarding from "./screens/Onboarding";
import Resolve from "./screens/Resolve";
import { useResolveStore } from "./store/resolveStore";
import { usePendingReviewStore } from "./store/pendingReviewStore";
import type { Clarifications } from "./bindings/Clarifications";
import { useRecordingStore } from "./store/recordingStore";
import { useNotesStore } from "./store/notesStore";
import { useTourStore, useTourTarget } from "./store/tourStore";
import { useAlfredStatusStore, alfredStatusLabel } from "./store/alfredStatusStore";
import { useUpdateStore } from "./store/updateStore";
import RecordingBar from "./components/RecordingBar";
import { NoteTypeIcon } from "./utils/noteType";
import NoteContextMenu from "./components/notes/NoteContextMenu";
import GuidedTour from "./components/tour/GuidedTour";
import Toast from "./components/Toast";
import FeedbackWidget from "./components/FeedbackWidget";
import { t as translate, useI18nStore, useT } from "./i18n";

// ─── Logo — recording trigger AND the app's single status readout ──────────────
// (spec/03/10, ajusté après test) Top-left Alfred is where you look to know what
// he's doing: the butler label lives under the logo, and there is no separate
// status pill in the topbar. Click: idle → start + guidance page; recording →
// STOP; transcribing/thinking → guidance page (progress).

function AlfredLogo() {
  const t = useT();
  const navigate = useNavigate();
  const [hover, setHover] = useState(false);
  const recStatus = useRecordingStore((s) => s.status);
  const startRecording = useRecordingStore((s) => s.startRecording);
  const stopRecording = useRecordingStore((s) => s.stopRecording);
  const butler = useAlfredStatusStore((s) => s.state);
  const target = useAlfredStatusStore((s) => s.target);
  const progress = useAlfredStatusStore((s) => s.progress);
  const selectFile = useNotesStore((s) => s.selectFile);

  const isRecording = recStatus === "recording" || recStatus === "paused";
  // Enchaîner pendant qu'Alfred transcrit/analyse (spec/03 § « Enregistrer
  // pendant qu'Alfred transcrit/analyse », feedback tests) : le backend enfile
  // déjà une 2e prise sans bloquer (voir `audio::stop_recording`/
  // `enqueue_processing` dans `lib.rs` — le micro est libre dès le `stop`, la
  // transcription tourne dans un worker en file). Le seul blocage était ici :
  // `recStatus` confondait CAPTURE et TRAITEMENT, donc `handleClick` ne
  // démarrait que si `idle`. Une capture n'est active que sur "recording"/
  // "paused" — "processing"/"error" ("Alfred transcrit/cogite") n'empêchent
  // plus de relancer ; "stopping"/"stopped" restent bloquants (transition très
  // brève, ou revue contexte en attente d'une décision explicite).
  const canStartNewTake = recStatus === "idle" || recStatus === "processing" || recStatus === "error";
  const busy = butler !== "idle";

  const handleClick = () => {
    if (isRecording) {
      stopRecording();
    } else if (canStartNewTake) {
      startRecording();
      navigate("/recording");
    } else {
      navigate("/recording"); // "stopping"/"stopped" — voir où ça en est
    }
  };

  // « Cliquer l'indicateur majordome navigue vers ce qu'Alfred fait » (spec/10).
  // Au repos (pas de cible), le libellé n'est pas cliquable.
  const goToTarget = () => {
    if (!target) return;
    if (target.targetPath) {
      selectFile(target.targetPath);
      navigate("/notes");
    } else if (target.targetRoute) {
      navigate(target.targetRoute);
    }
  };
  const clickableStatus = busy && !!target && (!!target.targetPath || !!target.targetRoute);
  // Visite guidée (spec/13) — pointé juste après la présentation pour
  // expliquer ce que ce point représente, avant le reste de la visite.
  const statusTourRef = useTourTarget("alfred-status");
  // Étape finale de la visite (feedback tests) — spotlight sur le VRAI bouton
  // qui déclenche l'enregistrement, plutôt qu'un aperçu statique déconnecté.
  const logoTourRef = useTourTarget("alfred-logo-button");

  const title = isRecording
    ? t("nav.logo.stopRecording")
    : canStartNewTake
      ? t("nav.logo.startRecording")
      : t("nav.logo.seeProgress");

  return (
    <div style={{ padding: "20px 20px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <button
        ref={logoTourRef}
        onClick={handleClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={title}
        style={{
          position: "relative", padding: 0, background: "none",
          cursor: "pointer", width: 132, height: 132,
          display: "block",
        }}
      >
        {/* L'encadré rouge d'enregistrement suivait un border-radius CSS fixe qui
            ne correspondait pas au contour réel (arrondi "squircle") de l'asset
            transparent — décalage visible aux coins (feedback tests). Un
            drop-shadow épouse le contour alpha réel de l'image, quel que soit
            son tracé, au lieu d'un cadre géométrique séparé. */}
        <img
          src={alfredAvatar}
          alt="Alfred"
          style={{
            width: "100%", height: "100%", display: "block",
            filter: [
              hover || isRecording ? "brightness(0.55)" : "",
              isRecording
                ? "drop-shadow(2px 0 0 var(--danger)) drop-shadow(-2px 0 0 var(--danger)) drop-shadow(0 2px 0 var(--danger)) drop-shadow(0 -2px 0 var(--danger))"
                : "",
            ].filter(Boolean).join(" ") || "none",
            transition: "filter 0.15s",
          }}
        />
        {isRecording ? (
          // Recording: hover offers the stop, otherwise a pulsing mic.
          <span style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--danger)", fontSize: 36,
            animation: hover ? "none" : "alfred-pulse 1.4s ease-in-out infinite",
          }}>
            {hover ? <MdStop /> : <MdMic />}
          </span>
        ) : hover && canStartNewTake ? (
          <span style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontSize: 34, animation: "alfred-pop 0.15s ease",
          }}>
            <MdMic />
          </span>
        ) : null}
      </button>

      {/* Butler status — THE status readout (no duplicate elsewhere). Cliquable
          quand Alfred travaille sur une cible : mène à ce qu'il fait (spec/10). */}
      <div
        ref={statusTourRef}
        onClick={clickableStatus ? goToTarget : undefined}
        title={clickableStatus ? t("nav.logo.seeWhatImProcessing") : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          fontSize: 12.5, whiteSpace: "nowrap",
          color: isRecording ? "var(--danger)" : busy ? "var(--accent)" : "var(--text-muted)",
          transition: "color 0.2s",
          cursor: clickableStatus ? "pointer" : "default",
          textDecoration: clickableStatus ? "underline dotted" : "none",
          textUnderlineOffset: 3,
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
          background: "currentColor",
          animation: busy || isRecording ? "alfred-pulse 1.4s ease-in-out infinite" : "none",
        }} />
        {alfredStatusLabel(butler, progress, t)}
      </div>
    </div>
  );
}

// ─── Nav item ─────────────────────────────────────────────────────────────────

function NavItem({
  to, icon, label, end = false, tourId,
}: { to: string; icon: React.ReactNode; label: string; end?: boolean; tourId?: string }) {
  // Guided tour (spec/13) spotlights specific nav items (e.g. Tâches) by id.
  const tourRef = useTourTarget(tourId ?? to);
  return (
    <NavLink
      ref={tourId ? tourRef : undefined}
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

/** Chemins comparables quel que soit le séparateur (backend Windows ↔ front). */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

/** « 16/07 14h32 » — date/heure secondaire des Récents (spec/07). */
function formatRecentDate(unixSeconds: number | bigint): string {
  const d = new Date(Number(unixSeconds) * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return hm;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

function Recents() {
  const t = useT();
  const navigate = useNavigate();
  const recents = useNotesStore(s => s.recents);
  const selectedPath = useNotesStore(s => s.selectedFile?.path ?? null);
  const fetchRecents = useNotesStore(s => s.fetchRecents);
  const selectFile = useNotesStore(s => s.selectFile);
  const renameNote = useNotesStore(s => s.renameNote);
  const deleteNote = useNotesStore(s => s.deleteNote);
  // Le point ambre = la note qu'Alfred TRAITE en ce moment (spec/10, feedback
  // tests) — plus « note sélectionnée » (le highlight suffit pour la sélection).
  const targetPath = useAlfredStatusStore(s => s.target?.targetPath ?? null);
  // Indicateur « à vérifier » persistant (spec/17 §3/spec/07, feedback tests).
  const pendingReviewIds = usePendingReviewStore(s => s.ids);
  const loadPersisted = useResolveStore(s => s.loadPersisted);
  const openReview = async (recordingId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (await loadPersisted(recordingId)) navigate("/resolve");
  };

  // Clic droit (spec/07, feedback tests) : mêmes actions Renommer/Supprimer que
  // l'arbre de Notes — sans ce menu, le clic droit ici tombait sur le menu
  // natif du navigateur (Retour/Actualiser/Imprimer…), incohérent avec le reste
  // de l'app.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; title: string } | null>(null);

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
        {t("nav.recents.title")}
      </div>
      {recents.map((item) => {
        const active = item.path === selectedPath;
        const processing = samePath(item.path, targetPath);
        const needsReview = !!item.recording_id && pendingReviewIds.has(item.recording_id);
        return (
          <div key={item.path} style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 24px", cursor: "pointer", fontSize: 13,
            color: "var(--text-secondary)",
            background: active ? "var(--active-bg)" : "transparent",
          }}
            onClick={() => { selectFile(item.path); navigate("/notes"); }}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, path: item.path, title: item.title });
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--active-bg)")}
            onMouseLeave={e => (e.currentTarget.style.background = active ? "var(--active-bg)" : "transparent")}
          >
            {/* Icône de type (spec/07) : transcription / compte-rendu / tâche / contexte / note. */}
            <NoteTypeIcon path={item.path} noteType={item.type} recordingId={item.recording_id} size={14} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden" }} title={item.title}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.title}
              </span>
              <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)" }}>
                {formatRecentDate(item.modified)}
              </span>
            </span>
            {needsReview && (
              <button
                onClick={(e) => openReview(item.recording_id!, e)}
                title={t("nav.recents.needsReview")}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: "none", border: "none", cursor: "pointer", padding: 0,
                  color: "var(--accent)", flexShrink: 0, fontSize: 14,
                }}
              >
                <MdFactCheck size={14} />
              </button>
            )}
            {processing && (
              <span
                title={t("nav.recents.workingOnThisNote")}
                style={{
                  width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flexShrink: 0,
                  animation: "alfred-pulse 1.4s ease-in-out infinite",
                }}
              />
            )}
          </div>
        );
      })}

      {contextMenu && (
        <NoteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onRename={() => {
            const name = window.prompt(t("nav.recents.renamePrompt"), contextMenu.title);
            if (name && name.trim()) renameNote(contextMenu.path, name.trim());
          }}
          onDelete={() => {
            if (window.confirm(t("nav.recents.deleteConfirm", { name: contextMenu.title }))) deleteNote(contextMenu.path);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar() {
  const t = useT();
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
        <NavItem to="/" icon={<MdAutoAwesome />} label={t("nav.sidebar.alfred")} tourId="nav-chat" end />
        <NavItem to="/tasks" icon={<MdCheckBox />} label={t("nav.sidebar.tasks")} tourId="nav-tasks" />
        <NavItem to="/notes" icon={<MdStickyNote2 />} label={t("nav.sidebar.notes")} tourId="nav-notes" />
        <NavItem to="/calendar" icon={<MdCalendarToday />} label={t("nav.sidebar.calendar")} tourId="nav-calendar" />
        <NavItem to="/graph" icon={<MdHub />} label={t("nav.sidebar.graph")} tourId="nav-graph" />

        <div style={{ height: 1, background: "var(--border)", margin: "12px 16px" }} />
        <Recents />
      </nav>

      <div style={{ borderTop: "1px solid var(--border)", padding: "8px" }}>
        <NavItem to="/settings" icon={<MdSettings />} label={t("nav.sidebar.settings")} />
      </div>
    </aside>
  );
}

// ─── Topbar ───────────────────────────────────────────────────────────────────
// The butler status lives under the sidebar logo (single readout) — the topbar
// only hosts the recording bandeau (timer + volume + stop) while recording.

function Topbar() {
  return (
    <div style={{
      height: 52, display: "flex", alignItems: "center", gap: 16,
      padding: "0 24px",
      borderBottom: "1px solid var(--border)",
      background: "var(--card-bg)",
      flexShrink: 0,
    }}>
      {/* No global search in v1 (spec/10) — spacer keeps the right-side cluster pinned right. */}
      <div style={{ flex: 1 }} />

      <RecordingBar />

      <FeedbackWidget />
    </div>
  );
}

// ─── Main layout ──────────────────────────────────────────────────────────────

function AppInner() {
  const t = useT();
  const setStatus = useRecordingStore((s) => s.setStatus);
  const setAlfredState = useAlfredStatusStore((s) => s.set);
  const setAlfredTarget = useAlfredStatusStore((s) => s.setTarget);
  const setAlfredProgress = useAlfredStatusStore((s) => s.setProgress);
  const setResolveSession = useResolveStore((s) => s.setSession);
  const fetchPendingReview = usePendingReviewStore((s) => s.fetch);
  // Ingestion failures must be VISIBLE: a silent one is indistinguishable from
  // "the feature doesn't work" (compte-rendu + tasks just never appear).
  const [ingestError, setIngestError] = useState<string | null>(null);
  // Same rule for transcription (spec/04) — typical case: onboarding skipped
  // without downloading a Whisper model, first recording fails.
  const [transcriptionError, setTranscriptionError] =
    useState<{ message: string; modelMissing: boolean } | null>(null);
  const navigate = useNavigate();

  // Vérification de mise à jour au démarrage (spec/27) — une seule fois par
  // session, fire-and-forget : un échec réseau reste silencieux ici (pas de
  // toast), contrairement au bouton manuel des Réglages qui affiche l'erreur.
  useEffect(() => {
    useUpdateStore.getState().checkForUpdate();
  }, []);

  useEffect(() => {
    const unsubs: (() => void)[] = [];

    // Indicateur « à vérifier » persistant (spec/17 §3/spec/07, feedback tests) :
    // chargé une fois au montage, puis rafraîchi à chaque changement (nouvelle
    // vérification en attente OU résolue par un Valider ailleurs).
    fetchPendingReview();
    listen("pending-clarifications-changed", () => fetchPendingReview()).then(fn => unsubs.push(fn));

    listen<{ status: string; duration_seconds: number; volume?: number; recording_id?: string; purpose?: string }>("recording-status-changed", (e) => {
      setStatus(
        e.payload.status as Parameters<typeof setStatus>[0],
        e.payload.duration_seconds,
        e.payload.volume,
        e.payload.recording_id,
      );
      if (e.payload.status === "recording" || e.payload.status === "paused") setAlfredState("recording");
      else if (e.payload.status === "stopping" || e.payload.status === "processing") setAlfredState("transcribing");
      // "stopped" (revue) : Alfred n'a rien lancé — il attend la décision.
      else if (e.payload.status === "stopped" || e.payload.status === "error" || e.payload.status === "idle") setAlfredState("idle");
    }).then(fn => unsubs.push(fn));

    // Progression réelle de la transcription (spec/04, feedback tests) — affichée
    // dans le libellé majordome (« Je prends note… {n} % »).
    listen<{ recording_id: string; percent: number }>("transcription-progress", (e) => {
      setAlfredProgress(e.payload.percent);
    }).then(fn => unsubs.push(fn));

    // Transcription done → the downstream (ingestion or context build) is now
    // running; the note brute existe : elle devient la CIBLE d'Alfred (spec/10 —
    // point ambre + indicateur cliquable).
    listen<{ recording_id: string; transcription_id: string; note_path?: string | null }>("transcription-complete", (e) => {
      setStatus("idle", 0);
      setAlfredState("thinking");
      if (e.payload.note_path) {
        setAlfredTarget({ targetPath: e.payload.note_path, recordingId: e.payload.recording_id });
      }
    }).then(fn => unsubs.push(fn));

    // Échec de transcription (spec/04) : rendre la main au majordome + bannière.
    listen<{ recording_id: string; message: string; model_missing?: boolean }>("transcription-failed", (e) => {
      setStatus("idle", 0);
      setAlfredState("idle");
      setTranscriptionError({
        message: e.payload.message,
        modelMissing: e.payload.model_missing ?? false,
      });
    }).then(fn => unsubs.push(fn));

    // Phases d'ingestion (spec/05/10) : `verifying` (analyse pré-clarifications,
    // spec/17 §3) → « Je vérifie… », `analyzing`/`summary` → « Je cogite… »,
    // `tasks` → « Je note les tâches… » (5ᵉ label), `done`/`error` → repos.
    // `report_path` (posé dès que le compte-rendu est écrit) déplace la cible
    // — et donc le point ambre — de la note brute vers le compte-rendu.
    listen<{ status: string; phase?: string; message?: string; report_path?: string; recording_id?: string }>("ingestion-status-changed", (e) => {
      if (e.payload.status === "running") {
        if (e.payload.phase === "verifying") {
          setAlfredState("verifying"); // cible inchangée : reste la note brute
          return;
        }
        setAlfredState(e.payload.phase === "tasks" ? "tasking" : "thinking");
        if (e.payload.report_path) {
          setAlfredTarget({ targetPath: e.payload.report_path, recordingId: e.payload.recording_id });
        }
        return;
      }
      setAlfredState("idle");
      if (e.payload.status === "error") {
        setIngestError(e.payload.message ?? translate("nav.ingestError.fallback"));
      }
    }).then(fn => unsubs.push(fn));

    // Fin du traitement « mode contexte » (spec/13) — hors visite guidée, il faut
    // aussi rendre la main au majordome.
    listen<{ status: string }>("context-status-changed", () => {
      setAlfredState("idle");
    }).then(fn => unsubs.push(fn));

    // Augmented ingestion (spec/17 §3): Claude has propositions to validate before
    // writing the compte-rendu. Stash the session; a banner invites the user to
    // the /resolve screen (never auto-navigate — don't yank them mid-task).
    listen<{ recording_id: string; note_title: string; text: string; clarifications: Clarifications; summary?: boolean; tasks?: boolean }>(
      "clarifications-ready",
      (e) => {
        // Invite visible (spec/10/17 §3) plutôt qu'un retour silencieux au
        // repos : la pastille reste active et cliquable vers /resolve.
        setAlfredState("reviewing");
        setAlfredTarget({ targetRoute: "/resolve", recordingId: e.payload.recording_id });
        setResolveSession({
          mode: "meeting",
          recordingId: e.payload.recording_id,
          noteTitle: e.payload.note_title,
          text: e.payload.text,
          clarifications: e.payload.clarifications,
          summary: e.payload.summary ?? true,
          tasks: e.payload.tasks ?? true,
          projectsConfirmed: e.payload.clarifications.projects_detected,
        });
      }
    ).then(fn => unsubs.push(fn));

    return () => unsubs.forEach(fn => fn());
  }, [setStatus, setAlfredState, setAlfredTarget, setAlfredProgress, setResolveSession, fetchPendingReview]);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <UpdateBanner />
        <Topbar />
        <main style={{ flex: 1, overflow: "auto" }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/recording" element={<RecordingGuide />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/calendar" element={<Agenda />} />
            <Route path="/graph" element={<Graph />} />
            <Route path="/feedback" element={<Feedback />} />
            <Route path="/resolve" element={<Resolve />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
      <GuidedTour />
      <ResolveBanner />
      <Toast />
      {ingestError && (
        <div style={{
          position: "fixed", bottom: 20, right: 20, zIndex: 1500,
          maxWidth: 420, padding: "12px 16px", borderRadius: 12,
          background: "var(--card-bg)", border: "1px solid var(--danger)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
          display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13,
        }}>
          <span style={{ color: "var(--danger)", flexShrink: 0, marginTop: 1 }}>⚠</span>
          <div style={{ color: "var(--text-primary)", lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("nav.ingestError.title")}</div>
            <div style={{ color: "var(--text-secondary)" }}>{ingestError}</div>
          </div>
          <button
            onClick={() => setIngestError(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 15, padding: 0, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
      )}
      {transcriptionError && (
        <div style={{
          position: "fixed", bottom: 20, right: 20, zIndex: 1500,
          maxWidth: 420, padding: "12px 16px", borderRadius: 12,
          background: "var(--card-bg)", border: "1px solid var(--danger)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
          display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13,
        }}>
          <span style={{ color: "var(--danger)", flexShrink: 0, marginTop: 1 }}>⚠</span>
          <div style={{ color: "var(--text-primary)", lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>La transcription a échoué</div>
            <div style={{ color: "var(--text-secondary)" }}>{transcriptionError.message}</div>
            {transcriptionError.modelMissing && (
              <button
                onClick={() => { setTranscriptionError(null); navigate("/settings"); }}
                style={{
                  marginTop: 8, padding: "5px 10px", borderRadius: 8,
                  border: "1px solid var(--border)", background: "var(--bg)",
                  color: "var(--text-primary)", cursor: "pointer", fontSize: 12,
                }}
              >
                Ouvrir les Réglages
              </button>
            )}
          </div>
          <button
            onClick={() => setTranscriptionError(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 15, padding: 0, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

// Invite to the resolution screen when a session is pending (spec/17 §3). Hidden
// while already on /resolve. Dismiss = hide the banner only (feedback tests) —
// the pending clarification stays persisted server-side (spec/17 §3/spec/07 :
// table `pending_clarifications`, indicateur « à vérifier » sur la note) et
// reste accessible plus tard, aucune finalisation n'est déclenchée ici.
function ResolveBanner() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useResolveStore((s) => s.session);
  const clear = useResolveStore((s) => s.clear);

  const dismiss = () => {
    invoke("track_event", { event: "resolve_banner_dismissed", props: {} }).catch(() => {});
    clear();
  };

  // Le mode contexte (visite guidée) est piloté par la visite — pas de bannière.
  if (!session || session.mode !== "meeting" || location.pathname === "/resolve") return null;

  // RÉVISÉ (spec/17 §3, feedback tests) : le pipeline automatique ne peuple
  // plus jamais `session` à 0 point à vérifier (finalisation directe côté back
  // dans ce cas — `run_ingestion_for_recording`). Le count===0 ci-dessous ne
  // survient donc plus que via le bouton manuel « Vérifier / corriger »
  // (`Notes.tsx`, ré-analyse volontaire) ou l'indicateur persistant, où Claude
  // peut légitimement ne rien avoir à signaler cette fois.
  const c = session.clarifications;
  const count =
    c.transcription_fixes.length + c.unclear_sentences.length + c.unassigned_tasks.length;

  return (
    <div style={{
      position: "fixed", bottom: 20, left: 20, zIndex: 1500,
      maxWidth: 380, padding: "12px 14px", borderRadius: 12,
      background: "var(--card-bg)", border: "1px solid var(--accent)",
      boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13,
    }}>
      <span style={{ color: "var(--accent)", flexShrink: 0, marginTop: 1, fontSize: 16 }}>💬</span>
      <div style={{ flex: 1, color: "var(--text-primary)", lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {count > 0
            ? t(count > 1 ? "nav.resolveBanner.pointsToCheckPlural" : "nav.resolveBanner.pointsToCheck", { count })
            : t("nav.resolveBanner.ready")}
        </div>
        <button
          onClick={() => navigate("/resolve")}
          style={{
            background: "var(--accent)", color: "#fff", border: "none",
            borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
          }}
        >
          {t("nav.resolveBanner.checkNow")}
        </button>
      </div>
      <button
        onClick={dismiss}
        title={t("nav.resolveBanner.dismissTitle")}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 15, padding: 0, lineHeight: 1 }}
      >
        ✕
      </button>
    </div>
  );
}

// ─── Bandeau de mise à jour (spec/27) ──────────────────────────────────────────
// Non intrusif, cohérent avec les autres bandeaux flottants de l'app
// (ResolveBanner/ingestError) : visible dès qu'une mise à jour est trouvée
// (démarrage ou bouton manuel des Réglages), masquable sans perdre la mise à
// jour (reproposée au prochain lancement). Aucune installation sans clic
// explicite sur « Mettre à jour ».
function UpdateBanner() {
  const t = useT();
  const status = useUpdateStore((s) => s.status);
  const info = useUpdateStore((s) => s.info);
  const installing = useUpdateStore((s) => s.installing);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const installUpdate = useUpdateStore((s) => s.installUpdate);
  const dismiss = useUpdateStore((s) => s.dismiss);

  if (status !== "available" || dismissed || !info) return null;

  // Barre en flux normal au-dessus de la Topbar (même esprit que le bandeau
  // « données de démo », spec/13/10) plutôt qu'une carte flottante — évite de
  // se superposer au ResolveBanner (bas-gauche) ou aux toasts d'erreur (bas-droite).
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "8px 24px", borderBottom: "1px solid var(--border)",
      background: "var(--dark-card)", fontSize: 12.5, color: "var(--text-muted)",
      flexShrink: 0,
    }}>
      <span>{t("nav.updateBanner.ready")} ({info.version})</span>
      {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => installUpdate()}
          disabled={installing}
          style={{
            background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6,
            padding: "3px 10px", cursor: installing ? "not-allowed" : "pointer", fontSize: 12,
          }}
        >
          {installing
            ? `${t("nav.updateBanner.installing")}${progress != null ? ` ${progress}%` : ""}`
            : t("nav.updateBanner.update")}
        </button>
        {!installing && (
          <button
            onClick={dismiss}
            title={t("nav.updateBanner.dismissTitle")}
            style={{
              background: "none", border: "1px solid var(--border)", borderRadius: 6,
              padding: "3px 10px", cursor: "pointer", fontSize: 12, color: "var(--text-secondary)",
            }}
          >
            ✕
          </button>
        )}
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
  // config. Session-scoped, so it clears when the app quits. **État React** —
  // pas une simple lecture de `sessionStorage` à chaque rendu (bug écran blanc,
  // spec/13, feedback tests) : sur une install déjà onboardée, `onboarded` vaut
  // déjà `true` quand le replay se termine, donc `setOnboarded(true)` est un
  // no-op (React n'y voit aucun changement) — sans état dédié, rien ne force le
  // nouveau rendu qui sortirait de la branche `forceOnboarding`, et l'app reste
  // bloquée sur l'écran vide de la garde de chargement juste en dessous.
  const [forceOnboarding, setForceOnboarding] = useState(
    () => sessionStorage.getItem("alfred_force_onboarding") === "1"
  );

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

  // Langue de l'UI (spec/21) — lue en parallèle, indépendamment de la garde
  // d'onboarding ci-dessus : défaut `fr` jusqu'à résolution, jamais de blocage.
  useEffect(() => { useI18nStore.getState().init(); }, []);

  // A genuine first-run completion also launches the guided tour (spec/13).
  // Replaying the intro from Settings ("Revoir l'introduction") does not — the
  // tour has its own separate "Revoir la visite guidée" entry.
  const finishOnboarding = () => {
    sessionStorage.removeItem("alfred_force_onboarding");
    setForceOnboarding(false);
    setOnboarded(true);
    useTourStore.getState().start();
  };

  const finishOnboardingReplay = () => {
    sessionStorage.removeItem("alfred_force_onboarding");
    setForceOnboarding(false);
    setOnboarded(true);
  };

  if (forceOnboarding) {
    return <Onboarding onDone={finishOnboardingReplay} />;
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
