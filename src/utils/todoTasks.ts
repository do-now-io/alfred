// Helpers for the Markdown to-do list (the file shown in the Tâches tab).
// A task is "important" when its line ends with ⭐ — flagged tasks surface in
// the Dashboard's "Ce qui mérite votre attention" section.
//
// `taskIndex` is the position among task lines, matching the order in which
// NotePreview wires its checkboxes, so the two stay in sync.

const TASK_RE = /^(\s*[-*+] )\[([ xX])\]\s?(.*)$/;
export const STAR = "⭐";

export interface TaskLine {
  lineIndex: number;
  taskIndex: number;
  /** Display text — without the checkbox prefix and without the trailing ⭐. */
  text: string;
  checked: boolean;
  important: boolean;
}

export function parseTasks(body: string): TaskLine[] {
  const tasks: TaskLine[] = [];
  let taskIndex = 0;
  body.split("\n").forEach((line, lineIndex) => {
    const m = TASK_RE.exec(line);
    if (!m) return;
    const checked = m[2].toLowerCase() === "x";
    const content = m[3];
    const important = /⭐\s*$/.test(content);
    const text = content.replace(/\s*⭐\s*$/, "").trim();
    tasks.push({ lineIndex, taskIndex, text, checked, important });
    taskIndex++;
  });
  return tasks;
}

function rebuildLine(line: string, opts: { checked?: boolean; important?: boolean }): string {
  const m = TASK_RE.exec(line);
  if (!m) return line;
  const prefix = m[1];
  const checked = opts.checked ?? m[2].toLowerCase() === "x";
  const important = opts.important ?? /⭐\s*$/.test(m[3]);
  const text = m[3].replace(/\s*⭐\s*$/, "").replace(/\s+$/, "");
  const box = checked ? "[x]" : "[ ]";
  return `${prefix}${box} ${text}${important ? ` ${STAR}` : ""}`;
}

function mapTaskLine(body: string, taskIndex: number, fn: (line: string) => string): string {
  const lines = body.split("\n");
  let i = 0;
  for (let li = 0; li < lines.length; li++) {
    if (!TASK_RE.test(lines[li])) continue;
    if (i === taskIndex) {
      lines[li] = fn(lines[li]);
      break;
    }
    i++;
  }
  return lines.join("\n");
}

export function toggleChecked(body: string, taskIndex: number): string {
  return mapTaskLine(body, taskIndex, (line) => {
    const m = TASK_RE.exec(line)!;
    return rebuildLine(line, { checked: m[2].toLowerCase() !== "x" });
  });
}

export function setImportant(body: string, taskIndex: number, important: boolean): string {
  return mapTaskLine(body, taskIndex, (line) => rebuildLine(line, { important }));
}

export function toggleImportant(body: string, taskIndex: number): string {
  return mapTaskLine(body, taskIndex, (line) => {
    const m = TASK_RE.exec(line)!;
    return rebuildLine(line, { important: !/⭐\s*$/.test(m[3]) });
  });
}
