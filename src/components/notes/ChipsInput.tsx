import { useRef, useState } from "react";
import { isSelf } from "../../store/profileStore";
import TagChip from "./TagChip";

/**
 * Champ « chips » multi-valeurs avec autocomplétion (spec/07, feedback tests) :
 * affiche les valeurs existantes (suggestions cliquables), filtre au fil de la
 * frappe (taper `te` propose `test`), Entrée / clic pour ajouter, une valeur
 * inédite se crée librement. Partagé entre tags/projets/participants
 * (`PropertiesPanel`) et le champ « Projets concernés » de `/resolve`
 * (spec/16b §1 — même combobox multi-projet, pas de composant dédié).
 */
export default function ChipsInput({
  values,
  onChange,
  suggestions,
  placeholder,
  colored,
  selfName,
  meLabel,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder: string;
  /** true → chips colorées (tags) ; false → chips neutres (projet/participants). */
  colored?: boolean;
  /** Profil local (spec/07, feedback tests) : la valeur qui matche est affichée
   *  « Moi » — reconnaissance de l'utilisateur parmi les participants. */
  selfName?: string;
  meLabel?: string;
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
              {selfName && isSelf(v, selfName) ? meLabel : v}
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
