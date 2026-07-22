import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeSearch } from "../utils/text";

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Texte secondaire optionnel, affiché à droite (ex. une date). */
  detail?: string;
}

/**
 * Combobox à sélection simple avec recherche (spec/06, filtre réunion) : un
 * bouton déclencheur habillé comme les `<select className="alfred-select">`
 * ouvre un panneau avec champ de filtre (insensible casse/accents via
 * `normalizeSearch`) et liste navigable au clavier (flèches / Entrée / Échap).
 * `value === ""` = aucune sélection (le déclencheur affiche `placeholder`,
 * qui sert aussi d'entrée « tout » en tête de liste).
 */
export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  title,
  clearTitle,
  width = 200,
}: {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  title?: string;
  clearTitle?: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const matches = useMemo(() => {
    const q = normalizeSearch(query.trim());
    if (!q) return options;
    return options.filter((o) => normalizeSearch(o.label).includes(q));
  }, [options, query]);

  // Liste affichée : l'entrée « tout » (value "") toujours en tête, hors
  // filtre, puis les options qui matchent la recherche.
  const items = useMemo<SearchableSelectOption[]>(
    () => [{ value: "", label: placeholder }, ...matches],
    [matches, placeholder]
  );

  const close = () => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  };

  const pick = (v: string) => {
    onChange(v);
    close();
    triggerRef.current?.focus();
  };

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Clic hors du composant → fermer (même pattern que FeedbackWidget :
  // `mousedown` + `contains`, plus fiable qu'un blur différé).
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        setActiveIndex(0);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[activeIndex] ?? items[0];
      if (it) pick(it.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else {
        close();
        triggerRef.current?.focus();
      }
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        type="button"
        className="alfred-select"
        title={selected ? selected.label : title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          textAlign: "left", maxWidth: width,
        }}
      >
        <span style={{
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: selected ? "var(--text-primary)" : undefined,
        }}>
          {selected ? selected.label : placeholder}
        </span>
        {selected && (
          <span
            role="button"
            title={clearTitle}
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
              triggerRef.current?.focus();
            }}
            style={{
              flexShrink: 0, color: "var(--text-muted)", fontSize: 13,
              lineHeight: 1, padding: "0 1px",
            }}
          >
            ×
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 60, marginTop: 4,
          width: 280, background: "var(--card-bg)",
          border: "1px solid var(--border)", borderRadius: 8,
          boxShadow: "0 6px 20px rgba(0,0,0,0.14)", padding: 4,
        }}>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={searchPlaceholder}
            style={{
              width: "100%", boxSizing: "border-box",
              border: "1px solid var(--border)", borderRadius: 6,
              padding: "5px 8px", fontSize: 13, outline: "none",
              background: "var(--bg)", color: "var(--text-primary)",
              fontFamily: "inherit",
            }}
          />
          <div ref={listRef} role="listbox" style={{ maxHeight: 260, overflowY: "auto", marginTop: 4 }}>
            {items.map((it, i) => (
              <div
                key={it.value === "" ? "\u0000all" : it.value}
                role="option"
                aria-selected={it.value === value}
                data-index={i}
                title={it.label}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(it.value);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 8px", borderRadius: 6, cursor: "pointer",
                  fontSize: 13,
                  background: i === activeIndex ? "var(--active-bg)" : "transparent",
                  color: it.value === value ? "var(--accent)" : "var(--text-primary)",
                  fontWeight: it.value === value ? 600 : 400,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                  {it.label}
                </span>
                {it.detail && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
                    {it.detail}
                  </span>
                )}
              </div>
            ))}
            {matches.length === 0 && (
              <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                {emptyLabel}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
