export default function Placeholder({ title }: { title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 32 }}>🚧</div>
      <div style={{ fontSize: 16, fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 13 }}>À venir</div>
    </div>
  );
}
