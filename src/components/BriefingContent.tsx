import { useEffect, useRef } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

// react-markdown sanitizes hrefs and strips unknown protocols (only http/https/
// mailto/… survive) — without this, wikilink: anchors render with href=""
function urlTransform(url: string): string {
  return url.startsWith("wikilink:") ? url : defaultUrlTransform(url);
}

// encodeURIComponent leaves ( ) untouched, which would break [x](url) syntax
function encodeRef(ref: string): string {
  return encodeURIComponent(ref).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// [[Note Title]] or [[Note Title|alias]] → markdown link with wikilink: scheme
function resolveWikilinks(text: string): string {
  let count = 0;
  const resolved = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    count++;
    const display = (alias?.trim() ?? target.trim()).replace(/"/g, "&quot;");
    const ref = target.trim().replace(/"/g, "&quot;");
    return `[${display}](wikilink:${encodeRef(ref)})`;
  });
  console.log(`[wikilink] Briefing: ${count} wikilink(s) detected in briefing`);
  return resolved;
}

interface Props {
  markdown: string;
  onWikilink: (ref: string) => void;
}

export default function BriefingContent({ markdown, onWikilink }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onWikilinkRef = useRef(onWikilink);
  onWikilinkRef.current = onWikilink;

  // Direct DOM wiring — React onClick on ReactMarkdown anchors is unreliable in this WebView
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const anchors = el.querySelectorAll<HTMLAnchorElement>("a");
    console.log(`[wikilink] Briefing: wiring ${anchors.length} anchor(s)`);
    anchors.forEach((a) => {
      const href = a.getAttribute("href") ?? "";
      console.log(`[wikilink] Briefing: anchor href="${href}" text="${a.textContent}"`);
      a.style.cursor = "pointer";

      a.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log(`[wikilink] Briefing: click on href="${href}"`);
        if (href.startsWith("wikilink:")) {
          const ref = decodeURIComponent(href.replace("wikilink:", ""));
          console.log(`[wikilink] Briefing: resolved ref="${ref}"`);
          onWikilinkRef.current?.(ref);
        } else if (href.startsWith("http://") || href.startsWith("https://")) {
          import("@tauri-apps/plugin-shell").then(({ open }) => open(href));
        }
      };
    });
  }); // no deps — runs after every render

  return (
    <div ref={containerRef}>
      <style>{BRIEFING_CSS}</style>
      <div className="alfred-briefing">
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform}>
          {resolveWikilinks(markdown)}
        </ReactMarkdown>
      </div>
    </div>
  );
}

const BRIEFING_CSS = `
.alfred-briefing {
  font-size: 13.5px; line-height: 1.75; color: var(--text-secondary);
}
.alfred-briefing h1, .alfred-briefing h2, .alfred-briefing h3 {
  color: var(--text-primary); font-weight: 700;
}
.alfred-briefing h1 { font-size: 16px; margin: 22px 0 10px; }
.alfred-briefing h2 { font-size: 15px; margin: 22px 0 10px; }
.alfred-briefing h3 { font-size: 14px; margin: 20px 0 8px; }
.alfred-briefing h1:first-child, .alfred-briefing h2:first-child, .alfred-briefing h3:first-child {
  margin-top: 2px;
}
.alfred-briefing p { margin: 0 0 14px; }
.alfred-briefing strong { color: var(--text-primary); font-weight: 600; }
.alfred-briefing ul, .alfred-briefing ol { margin: 0 0 16px; padding-left: 22px; }
.alfred-briefing li { margin-bottom: 8px; }
.alfred-briefing li p { margin: 0; }
.alfred-briefing a {
  color: var(--accent); text-decoration: none; font-weight: 500;
  border-bottom: 1px solid rgba(200,145,74,0.4);
}
.alfred-briefing blockquote {
  margin: 14px 0; padding: 8px 16px;
  border-left: 3px solid var(--accent); background: var(--active-bg);
  border-radius: 0 6px 6px 0;
}
.alfred-briefing hr { border: none; border-top: 1px solid var(--border); margin: 18px 0; }
`;
