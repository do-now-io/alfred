import { useState } from "react";
import { MdCalendarToday, MdLabel, MdCategory, MdToggleOn } from "react-icons/md";
import type { NoteMetadata } from "../../bindings/NoteMetadata";
import TagChip from "./TagChip";

interface Props {
  metadata: NoteMetadata;
  onChange: (updated: NoteMetadata) => void;
}

export default function PropertiesPanel({ metadata, onChange }: Props) {
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");

  const update = (patch: Partial<NoteMetadata>) =>
    onChange({ ...metadata, ...patch });

  const removeTag = (i: number) =>
    update({ tags: metadata.tags.filter((_, idx) => idx !== i) });

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !metadata.tags.includes(t)) {
      update({ tags: [...metadata.tags, t] });
    }
    setTagInput("");
    setAddingTag(false);
  };

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

        {/* Tags */}
        <Row icon={<MdLabel />} label="tags">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
            {metadata.tags.map((tag, i) => (
              <TagChip key={tag} tag={tag} onRemove={() => removeTag(i)} />
            ))}
            {addingTag ? (
              <input
                autoFocus
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") addTag();
                  if (e.key === "Escape") { setAddingTag(false); setTagInput(""); }
                }}
                onBlur={addTag}
                placeholder="nouveau tag"
                style={{ ...inputStyle, width: 100 }}
              />
            ) : (
              <button
                onClick={() => setAddingTag(true)}
                style={{
                  background: "none", border: "1px dashed var(--border)",
                  borderRadius: 20, padding: "2px 8px", cursor: "pointer",
                  fontSize: 12, color: "var(--text-muted)",
                }}
              >
                + tag
              </button>
            )}
          </div>
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
