// Tracks which tasks have been opened at least once (spec/06, feedback tests) —
// purely a local UI nicety (per-device), not vault state: `Todo.md` has no
// concept of "seen". A task not yet opened gets highlighted in the Kanban.

const OPENED_KEY = "alfred_tasks_opened_ids";
const SEEDED_KEY = "alfred_tasks_opened_seeded";

function loadOpenedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(OPENED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveOpenedIds(ids: Set<string>) {
  try {
    localStorage.setItem(OPENED_KEY, JSON.stringify([...ids]));
  } catch {
    /* localStorage unavailable — highlighting just won't persist across reloads */
  }
}

export function markTaskOpened(id: string) {
  const ids = loadOpenedIds();
  if (!ids.has(id)) {
    ids.add(id);
    saveOpenedIds(ids);
  }
}

/**
 * First-ever run only: seeds the "opened" set with every task that already
 * exists, so shipping this feature doesn't retroactively light up an entire
 * pre-existing backlog as "new". After this, only genuinely new tasks (added
 * after the seed) can ever be highlighted.
 */
function ensureSeeded(existingIds: string[]) {
  try {
    if (localStorage.getItem(SEEDED_KEY)) return;
    saveOpenedIds(new Set(existingIds));
    localStorage.setItem(SEEDED_KEY, "1");
  } catch {
    /* best-effort — worst case the backlog lights up once */
  }
}

/** Snapshot of "new" (never-opened) task ids — call once per Kanban page open,
 *  not on every task-list refresh, so a task streaming in while the page is
 *  already open doesn't retroactively join the highlighted set. */
export function computeNewTaskIds(currentIds: string[]): Set<string> {
  ensureSeeded(currentIds);
  const opened = loadOpenedIds();
  return new Set(currentIds.filter((id) => !opened.has(id)));
}
