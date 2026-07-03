interface Props {
  tag: string;
  onRemove?: () => void;
}

const TAG_COLORS = [
  { bg: "#EDE9FE", text: "#6D28D9" },
  { bg: "#DCFCE7", text: "#15803D" },
  { bg: "#FEF3C7", text: "#B45309" },
  { bg: "#DBEAFE", text: "#1D4ED8" },
  { bg: "#FCE7F3", text: "#9D174D" },
  { bg: "#F0FDF4", text: "#166534" },
];

function tagColor(tag: string) {
  let hash = 0;
  for (const c of tag) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return TAG_COLORS[hash % TAG_COLORS.length];
}

export default function TagChip({ tag, onRemove }: Props) {
  const { bg, text } = tagColor(tag);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      background: bg, color: text,
      padding: "2px 8px", borderRadius: 20, fontSize: 12, fontWeight: 500,
    }}>
      {tag}
      {onRemove && (
        <button
          onClick={onRemove}
          style={{
            background: "none", border: "none", padding: 0,
            cursor: "pointer", color: text, fontSize: 11, lineHeight: 1,
            opacity: 0.7,
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}
