// Live mic volume (spec/03 "feedback live") as a small bar meter. RMS values in
// practice sit well under 1.0, so a mild boost + curve keeps normal speech
// visibly animated instead of pinned near the bottom. Shared by the topbar
// recording bar and the recording guidance page (spec/03).

const METER_BARS = 4;

export default function VolumeMeter({ volume, size = "sm" }: { volume: number; size?: "sm" | "lg" }) {
  const level = Math.min(1, Math.sqrt(volume) * 1.8);
  const scale = size === "lg" ? 3 : 1;
  const barWidth = 3 * scale;
  const gap = 2 * scale;
  const barHeight = (i: number) => (4 + i * 3) * scale;

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap, height: barHeight(METER_BARS - 1) }}>
      {Array.from({ length: METER_BARS }).map((_, i) => {
        const threshold = (i + 1) / METER_BARS;
        const active = level >= threshold - 1 / METER_BARS / 2;
        return (
          <span
            key={i}
            style={{
              width: barWidth,
              height: barHeight(i),
              borderRadius: barWidth / 3,
              background: active ? "var(--danger)" : "rgba(128,128,128,0.25)",
              transition: "background 0.12s ease",
            }}
          />
        );
      })}
    </div>
  );
}
