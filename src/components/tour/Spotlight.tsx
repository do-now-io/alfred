import { useEffect, useState } from "react";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Tracks a target element's viewport rect, live across resize/scroll/layout changes. */
function useTargetRect(target: HTMLElement | null | undefined): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }
    const update = () => {
      const r = target.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    update();

    const ro = new ResizeObserver(update);
    ro.observe(target);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [target]);

  return rect;
}

/**
 * Highlights `target` with a glowing ring over a dimmed backdrop, and positions
 * `children` (a tooltip card) next to it. Purely visual — pointer-events pass
 * through everywhere, so the tour never blocks the real UI underneath.
 */
export function Spotlight({
  target,
  children,
  padding = 8,
}: {
  target: HTMLElement | null | undefined;
  /** Omit for a bare highlight ring with no tooltip (e.g. a 2nd simultaneous
   *  spotlight) — no invisible click-blocking overlay is rendered in that case. */
  children?: React.ReactNode;
  padding?: number;
}) {
  const rect = useTargetRect(target);
  if (!rect) return null;

  const highlightStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 2100,
    pointerEvents: "none",
    top: rect.top - padding,
    left: rect.left - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
    borderRadius: 14,
    boxShadow: "0 0 0 4px var(--accent), 0 0 0 9999px rgba(0,0,0,0.55)",
    transition: "top 0.25s ease, left 0.25s ease, width 0.25s ease, height 0.25s ease",
  };

  const spaceBelow = window.innerHeight - (rect.top + rect.height);
  const below = spaceBelow > 170;
  const tooltipStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 2101,
    left: Math.min(Math.max(rect.left, 16), window.innerWidth - 336),
    top: below ? rect.top + rect.height + padding + 14 : undefined,
    bottom: below ? undefined : window.innerHeight - rect.top + padding + 14,
    width: 320,
    pointerEvents: "auto",
    transition: "top 0.25s ease, bottom 0.25s ease, left 0.25s ease",
  };

  return (
    <>
      <div style={highlightStyle} />
      {children != null && <div style={tooltipStyle}>{children}</div>}
    </>
  );
}
