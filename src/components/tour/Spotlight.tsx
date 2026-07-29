import { useEffect, useState } from "react";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Tracks a target element's viewport rect, live across resize/scroll/layout changes.
 *  Polled every frame rather than only on `ResizeObserver`/`resize`/`scroll`: a
 *  sibling appearing above the target (e.g. the demo-content banner popping in
 *  after an async check) shifts the target's *position* without changing its own
 *  size, which `ResizeObserver` never reports — leaving the spotlight stuck at a
 *  stale position (feedback tests). `getBoundingClientRect` is cheap enough for
 *  a per-frame poll, and the state only updates (re-render) when values actually
 *  changed. */
function useTargetRect(target: HTMLElement | null | undefined): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }

    const measure = () => {
      const r = target.getBoundingClientRect();
      setRect((prev) =>
        prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height },
      );
    };
    // Measure synchronously on mount too — a tab that isn't focused/visible can
    // have its first `requestAnimationFrame` throttled/delayed by the browser,
    // which would otherwise leave the spotlight invisible until that first tick.
    measure();
    let raf = requestAnimationFrame(function tick() {
      measure();
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
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
