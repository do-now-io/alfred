import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import ForceGraph2D from "react-force-graph-2d";
import { MdRefresh, MdHub } from "react-icons/md";
import { useNotesStore } from "../store/notesStore";
import type { VaultGraph } from "../bindings/VaultGraph";

const TAG_COLOR = "#5FAE54";
const NOTE_COLOR = "#8A8A8A";
const FOLDER_PALETTE = ["#E0A23C", "#D4574E", "#5B8DD9", "#9B6BD4", "#4AAE9B", "#C9B458"];

interface GNode {
  id: string;
  label: string;
  kind: "note" | "tag";
  path: string | null;
  degree: number;
  color: string;
  x?: number;
  y?: number;
  fx?: number; // pinned position after a manual drag
  fy?: number;
}

export default function Graph() {
  const [graph, setGraph] = useState<VaultGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<GNode | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  const navigate = useNavigate();
  const selectFile = useNotesStore(s => s.selectFile);

  const fetchGraph = useCallback(() => {
    invoke<VaultGraph>("get_vault_graph")
      .then(g => { setGraph(g); setError(null); })
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => {
    fetchGraph();
    let unsub: (() => void) | undefined;
    listen("notes-updated", () => fetchGraph()).then(fn => { unsub = fn; });
    return () => unsub?.();
  }, [fetchGraph]);

  // Track container size so the canvas fills the pane
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build force-graph data: degree (node size), folder colors, adjacency (hover highlight)
  const data = useMemo(() => {
    if (!graph) return null;

    const degree = new Map<string, number>();
    const neighbors = new Map<string, Set<string>>();
    for (const l of graph.links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
      if (!neighbors.has(l.source)) neighbors.set(l.source, new Set());
      if (!neighbors.has(l.target)) neighbors.set(l.target, new Set());
      neighbors.get(l.source)!.add(l.target);
      neighbors.get(l.target)!.add(l.source);
    }

    const folders = [...new Set(graph.nodes.map(n => n.folder).filter((f): f is string => !!f))].sort();
    const folderColor = new Map(folders.map((f, i) => [f, FOLDER_PALETTE[i % FOLDER_PALETTE.length]]));

    const nodes: GNode[] = graph.nodes.map(n => ({
      id: n.id,
      label: n.label,
      kind: n.kind as "note" | "tag",
      path: n.path,
      degree: degree.get(n.id) ?? 0,
      color: n.kind === "tag"
        ? TAG_COLOR
        : (n.folder ? folderColor.get(n.folder)! : NOTE_COLOR),
    }));

    const links = graph.links.map(l => ({ source: l.source, target: l.target }));
    const legend = folders.map(f => ({ folder: f, color: folderColor.get(f)! }));

    // graphData must keep a stable reference: the lib compares by reference and
    // restarts the force simulation whenever it thinks the data changed
    return { graphData: { nodes, links }, nodes, neighbors, legend };
  }, [graph]);

  const highlightSet = useMemo(() => {
    if (!hoverNode || !data) return null;
    const set = new Set(data.neighbors.get(hoverNode.id) ?? []);
    set.add(hoverNode.id);
    return set;
  }, [hoverNode, data]);

  const nodeRadius = (node: GNode) =>
    (node.kind === "tag" ? 2 : 2.5) + Math.sqrt(node.degree) * 1.1;

  // Per-node opacity, eased toward its target each frame so the dimming
  // fades in/out smoothly instead of snapping
  const nodeAlphas = useRef(new Map<string, number>());
  const EASE = 0.12; // per-frame easing factor (~0.4s to settle at 60fps)

  const easedAlpha = useCallback((id: string) => {
    const target = highlightSet ? (highlightSet.has(id) ? 1 : 0.12) : 1;
    const current = nodeAlphas.current.get(id) ?? 1;
    const next = Math.abs(target - current) < 0.01 ? target : current + (target - current) * EASE;
    nodeAlphas.current.set(id, next);
    return next;
  }, [highlightSet]);

  const paintNode = useCallback((node: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
    const r = nodeRadius(node);
    const alpha = easedAlpha(node.id);

    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
    ctx.fillStyle = node.color;
    ctx.fill();

    // Labels fade in with zoom; the hovered node's label is always shown
    const isHovered = hoverNode?.id === node.id;
    const zoomAlpha = Math.max(0, Math.min(1, (scale - 1.2) / 1.3));
    const labelAlpha = isHovered ? 1 : zoomAlpha * alpha;
    if (labelAlpha > 0.02) {
      const fontSize = Math.max(11 / scale, 2);
      ctx.globalAlpha = labelAlpha;
      ctx.font = `${isHovered ? "600 " : ""}${fontSize}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = node.kind === "tag" ? TAG_COLOR : "#555";
      ctx.fillText(node.label, node.x!, node.y! + r + 1.5);
    }
    ctx.globalAlpha = 1;
  }, [easedAlpha, hoverNode]);

  const paintPointerArea = useCallback((node: GNode, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    ctx.arc(node.x!, node.y!, nodeRadius(node) + 3, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  const linkId = (end: unknown): string =>
    typeof end === "object" && end !== null ? (end as GNode).id : String(end);

  const handleNodeClick = useCallback(async (node: GNode) => {
    if (node.kind === "note" && node.path) {
      await selectFile(node.path);
      navigate("/notes");
    }
  }, [selectFile, navigate]);

  return (
    <div ref={containerRef} style={{ position: "relative", height: "100%", overflow: "hidden" }}>
      {error && (
        <div style={{
          height: "100%", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 10,
          color: "var(--text-muted)",
        }}>
          <MdHub size={32} />
          <div style={{ fontSize: 14 }}>{error}</div>
        </div>
      )}

      {!error && data && (
        <>
          <ForceGraph2D
            width={size.width}
            height={size.height}
            graphData={data.graphData}
            backgroundColor="rgba(0,0,0,0)"
            nodeCanvasObject={paintNode as never}
            nodePointerAreaPaint={paintPointerArea as never}
            nodeLabel={() => ""}
            linkColor={(l: { source: unknown; target: unknown }) => {
              // follow the eased opacity of the link's endpoints (read-only —
              // the node paint pass drives the animation)
              const a = Math.min(
                nodeAlphas.current.get(linkId(l.source)) ?? 1,
                nodeAlphas.current.get(linkId(l.target)) ?? 1,
              );
              const highlighted = highlightSet
                && highlightSet.has(linkId(l.source)) && highlightSet.has(linkId(l.target));
              return highlighted
                ? `rgba(200,145,74,${0.8 * a})`
                : `rgba(160,160,160,${0.25 * a})`;
            }}
            linkWidth={(l: { source: unknown; target: unknown }) =>
              highlightSet && highlightSet.has(linkId(l.source)) && highlightSet.has(linkId(l.target)) ? 1.2 : 0.6
            }
            autoPauseRedraw={false}
            onNodeHover={(n: GNode | null) => setHoverNode(n)}
            onNodeClick={handleNodeClick as never}
            onNodeDragEnd={((node: GNode) => {
              node.fx = node.x;
              node.fy = node.y;
            }) as never}
            d3VelocityDecay={0.3}
            cooldownTicks={300}
          />

          {/* Legend + refresh overlay */}
          <div style={{
            position: "absolute", top: 14, left: 16,
            display: "flex", flexDirection: "column", gap: 6,
            background: "var(--card-bg)", border: "1px solid var(--border)",
            borderRadius: 10, padding: "10px 14px",
            fontSize: 12, color: "var(--text-secondary)",
            boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                {data.nodes.filter(n => n.kind === "note").length} notes · {data.nodes.filter(n => n.kind === "tag").length} tags
              </span>
              <button
                onClick={fetchGraph}
                title="Rafraîchir le graphe"
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--text-secondary)", padding: 2, display: "flex",
                }}
              >
                <MdRefresh size={15} />
              </button>
            </div>
            <LegendRow color={TAG_COLOR} label="Tags" />
            {data.legend.map(l => (
              <LegendRow key={l.folder} color={l.color} label={l.folder} />
            ))}
            <LegendRow color={NOTE_COLOR} label="Notes (racine)" />
          </div>
        </>
      )}
    </div>
  );
}

function LegendRow({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span>{label}</span>
    </div>
  );
}
