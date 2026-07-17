import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MdCalendarToday, MdLabel, MdCategory, MdToggleOn, MdFolderSpecial, MdGroups } from "react-icons/md";
import type { NoteMetadata } from "../../bindings/NoteMetadata";
import TagChip from "./TagChip";

interface Props {
  metadata: NoteMetadata;
  onChange: (updated: NoteMetadata) => void;
}

/**
 * Champ « chips » multi-valeurs avec autocomplétion (spec/07, feedback tests) :
 * affiche les valeurs existantes (suggestions cliquables), filtre au fil de la
 * frappe (taper `te` propose `test`), Entrée / clic pour ajouter, une valeur
 * inédite se crée librement. Partagé entre tags, projets et participants.
 */
function ChipsInput({
  values,
  onChange,
  suggestions,
  placeholder,
  colored,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder: string;
  /** true → chips colorées (tags) ; false → chips neutres (projet/participants). */
  colored?: boolean;
}) {
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>();

  const add = (raw: string) => {
    const v = raw.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) {
      onChange([...values, v]);
    }
    setInput("");
  };
  const remove = (i: number) => onChange(values.filter((_, idx) => idx !== i));

  const q = input.trim().toLowerCase();
  const matches = suggestions
    .filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()))
    .filter((s) => (q ? s.toLowerCase().includes(q) : true))
    .slice(0, 8);

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {values.map((v, i) =>
          colored ? (
            <TagChip key={v} tag={v} onRemove={() => remove(i)} />
          ) : (
            <span
              key={v}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                background: "var(--active-bg)", color: "var(--accent)",
                padding: "2px 8px", borderRadius: 20, fontSize: 12, fontWeight: 500,
              }}
            >
              {v}
              <button
                onClick={() => remove(i)}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", fontSize: 11, lineHeight: 1, opacity: 0.7 }}
              >
                ×
              </button>
            </span>
          )
        )}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => { clearTimeout(blurTimer.current); setFocused(true); }}
          onBlur={() => { blurTimer.current = setTimeout(() => setFocused(false), 150); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); add(input); }
            if (e.key === "Escape") setInput("");
            if (e.key === "Backspace" && !input && values.length) remove(values.length - 1);
          }}
          placeholder={placeholder}
          style={{
            background: "transparent", border: "none", outline: "none",
            fontSize: 13, color: "var(--text-primary)", padding: "2px 0",
            fontFamily: "inherit", minWidth: 110, flex: 1,
          }}
        />
      </div>

      {focused && matches.length > 0 && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 60, marginTop: 4,
          background: "var(--card-bg)", border: "1px solid var(--border)",
          borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.14)",
          padding: 4, display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 320,
        }}>
          {matches.map((s) => (
            <button
              key={s}
              onMouseDown={(e) => { e.preventDefault(); add(s); }}
              style={{
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 20, padding: "2px 9px", cursor: "pointer",
                fontSize: 12, color: "var(--text-secondary)",
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PropertiesPanel({ metadata, onChange }: Props) {
  // Valeurs existantes du vault, pour l'autocomplétion (spec/07 — list_tags /
  // list_projects). Chargées à l'affichage du panneau ; un échec laisse juste
  // les suggestions vides.
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allProjects, setAllProjects] = useState<string[]>([]);

  useEffect(() => {
    invoke<string[]>("list_tags").then(setAllTags).catch(() => {});
    invoke<string[]>("list_projects").then(setAllProjects).catch(() => {});
  }, []);

  const update = (patch: Partial<NoteMetadata>) =>
    onChange({ ...metadata, ...patch });

  return (
    <div style={{
      padding: "16px 24px",
      borderBottom: "1px solid var(--border)",
      background: "var(--card-bg)",
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 12 }}>
        Properties
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Date */}
        <Row icon={<MdCalendarToday />} label="date">
          <input
            type="date"
            value={metadata.date}
            onChange={e => update({ date: e.target.value })}
            style={inputStyle}
          />
        </Row>

        {/* Tags — existants + autocomplétion (spec/07) */}
        <Row icon={<MdLabel />} label="tags">
          <ChipsInput
            colored
            values={metadata.tags}
            onChange={(tags) => update({ tags })}
            suggestions={allTags}
            placeholder="+ tag"
          />
        </Row>

        {/* Projets — MULTI-sélection, combobox sur les projets du vault (spec/07) */}
        <Row icon={<MdFolderSpecial />} label="projets">
          <ChipsInput
            values={metadata.project}
            onChange={(project) => update({ project })}
            suggestions={allProjects}
            placeholder="+ projet"
          />
        </Row>

        {/* Participants (spec/07) */}
        <Row icon={<MdGroups />} label="avec">
          <ChipsInput
            values={metadata.participants}
            onChange={(participants) => update({ participants })}
            suggestions={[]}
            placeholder="+ participant"
          />
        </Row>

        {/* Type */}
        <Row icon={<MdCategory />} label="type">
          <select
            className="alfred-select"
            value={metadata.type}
            onChange={e => update({ type: e.target.value })}
          >
            <option value="note">note</option>
            <option value="meeting">meeting</option>
            <option value="task">task</option>
          </select>
        </Row>

        {/* Status */}
        <Row icon={<MdToggleOn />} label="status">
          <select
            className="alfred-select"
            value={metadata.status}
            onChange={e => update({ status: e.target.value })}
          >
            <option value="active">active</option>
            <option value="archived">archived</option>
          </select>
        </Row>
      </div>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span style={{ fontSize: 14, width: 16, flexShrink: 0, color: "var(--text-muted)", marginTop: 2, display: "flex", alignItems: "center" }}>{icon}</span>
      <span style={{ fontSize: 13, color: "var(--text-secondary)", width: 64, flexShrink: 0, marginTop: 2 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "transparent", border: "none", outline: "none",
  fontSize: 13, color: "var(--text-primary)", padding: 0,
  fontFamily: "inherit",
};
