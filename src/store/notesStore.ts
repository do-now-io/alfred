import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { VaultNode } from "../bindings/VaultNode";
import type { NoteFile } from "../bindings/NoteFile";
import type { NoteMetadata } from "../bindings/NoteMetadata";
import type { RecentNote } from "../bindings/RecentNote";

// Insensible casse/accents (spec/23 — « robustesse de résolution ») : un
// wikilink tapé sans accent doit tout de même matcher « Réunion ».
function normalizeRef(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Miroir de `sanitize_filename` (src-tauri/src/notes/vault.rs) — un titre de
// réunion contenant un caractère illégal dans un nom de fichier (le cas le
// plus courant en français : « Point projet : Atlas ») est écrit sur disque
// avec ces caractères remplacés par `-`. Le wikilink de provenance posé sur
// la ligne de tâche (spec/05/06), lui, porte le titre BRUT — sans ce repli,
// la résolution échouait silencieusement pour tout titre avec un `:`/`/`
// (spec/23, bug remonté).
function sanitizeFilenameLike(name: string): string {
  const safe = name.replace(/[/\\:*?"<>|]/g, "-").trim();
  return safe.length > 80 ? safe.slice(0, 80) : safe;
}

// Recursively search a VaultNode tree for a file whose stem matches `ref`
export function findNodeByRef(node: VaultNode, ref: string): string | null {
  const target = normalizeRef(ref);
  const targetSanitized = normalizeRef(sanitizeFilenameLike(ref));
  if (!node.is_dir) {
    const stem = normalizeRef(node.name); // already stripped of .md
    if (stem === target || stem === targetSanitized) return node.path;
  }
  for (const child of node.children) {
    const found = findNodeByRef(child, ref);
    if (found) return found;
  }
  return null;
}

const MAX_HISTORY = 10;

interface NotesStore {
  tree: VaultNode | null;
  selectedFile: NoteFile | null;
  vaultPath: string | null;
  expandedPaths: Set<string>;
  history: string[]; // previously viewed note paths, most recent last
  recents: RecentNote[]; // 5 most recently *modified* notes (by file mtime)

  fetchTree: () => Promise<void>;
  fetchRecents: () => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  goBack: () => Promise<void>;
  openNoteByRef: (ref: string) => Promise<boolean>;
  createNote: (folder: string, title: string) => Promise<NoteFile>;
  updateNote: (path: string, metadata: NoteMetadata, body: string) => Promise<void>;
  deleteNote: (path: string) => Promise<void>;
  renameNote: (oldPath: string, newName: string) => Promise<void>;
  moveNote: (path: string, destFolder: string) => Promise<void>;
  createFolder: (parent: string, name: string) => Promise<void>;
  renameFolder: (oldPath: string, newName: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  fetchVaultPath: () => Promise<void>;
  setVaultPath: (path: string) => Promise<void>;
  pickVaultFolder: () => Promise<string | null>;
  toggleExpanded: (path: string) => void;
}

export const useNotesStore = create<NotesStore>((set, get) => ({
  tree: null,
  selectedFile: null,
  vaultPath: null,
  expandedPaths: new Set(),
  history: [],
  recents: [],

  fetchTree: async () => {
    try {
      const tree = await invoke<VaultNode>("get_vault_tree");
      set({ tree });
      get().fetchRecents();
    } catch {
      set({ tree: null });
    }
  },

  fetchRecents: async () => {
    try {
      const recents = await invoke<RecentNote[]>("get_recent_notes", { limit: 5 });
      set({ recents });
    } catch {
      set({ recents: [] });
    }
  },

  selectFile: async (path) => {
    try {
      const file = await invoke<NoteFile>("get_note_file", { path });
      const { selectedFile, history } = get();
      if (selectedFile && selectedFile.path !== path) {
        // a path appears at most once in the trail
        const next = [...history.filter(p => p !== selectedFile.path), selectedFile.path];
        set({ history: next.slice(-MAX_HISTORY) });
      }
      set({ selectedFile: file });
    } catch (e) {
      console.error("Failed to open note:", e);
    }
  },

  goBack: async () => {
    const remaining = [...get().history];
    while (remaining.length > 0) {
      const prev = remaining.pop()!;
      try {
        const file = await invoke<NoteFile>("get_note_file", { path: prev });
        set({ selectedFile: file, history: remaining });
        return;
      } catch {
        // note was deleted or moved — skip to the one before
      }
    }
    set({ history: remaining });
  },

  openNoteByRef: async (ref) => {
    let { tree } = get();
    console.log(`[wikilink] openNoteByRef: ref="${ref}", tree ${tree ? "already loaded" : "not loaded — fetching"}`);
    if (!tree) {
      await get().fetchTree();
      tree = get().tree;
    }
    if (!tree) {
      console.warn("[wikilink] openNoteByRef: vault tree unavailable (vault not configured?)");
      return false;
    }
    const path = findNodeByRef(tree, ref);
    console.log(`[wikilink] openNoteByRef: resolved path=${path ? `"${path}"` : "null (no file matches)"}`);
    if (!path) return false;
    await get().selectFile(path);
    return true;
  },

  createNote: async (folder, title) => {
    const file = await invoke<NoteFile>("create_note_file", { folder, title });
    await get().fetchTree();
    set({ selectedFile: file });
    return file;
  },

  updateNote: async (path, metadata, body) => {
    try {
      const file = await invoke<NoteFile>("update_note_file", { path, metadata, body });
      set({ selectedFile: file });
      // The save just bumped this note's mtime — refresh the "recently modified" list.
      get().fetchRecents();
    } catch (e) {
      console.error("Failed to save note:", e);
    }
  },

  deleteNote: async (path) => {
    await invoke("delete_note_file", { path });
    const { selectedFile, history } = get();
    if (selectedFile?.path === path) set({ selectedFile: null });
    set({ history: history.filter(p => p !== path) });
    await get().fetchTree();
  },

  renameNote: async (oldPath, newName) => {
    const file = await invoke<NoteFile>("rename_note_file", { oldPath, newName });
    await get().fetchTree();
    set({
      selectedFile: file,
      history: get().history.map(p => (p === oldPath ? file.path : p)),
    });
  },

  moveNote: async (path, destFolder) => {
    const file = await invoke<NoteFile>("move_note_file", { path, destFolder });
    await get().fetchTree();
    const { selectedFile } = get();
    set({
      selectedFile: selectedFile?.path === path ? file : selectedFile,
      history: get().history.map(p => (p === path ? file.path : p)),
    });
  },

  createFolder: async (parent, name) => {
    await invoke<string>("create_folder", { parent, name });
    await get().fetchTree();
  },

  renameFolder: async (oldPath, newName) => {
    const newPath = await invoke<string>("rename_folder", { oldPath, newName });
    await get().fetchTree();
    // Les notes sous ce dossier ont un chemin qui commence par l'ancien préfixe
    // — on le fait suivre pour ne pas perdre la sélection/l'historique en cours.
    const prefix = oldPath.endsWith("/") ? oldPath : `${oldPath}/`;
    const rebase = (p: string) => (p === oldPath || p.startsWith(prefix) ? newPath + p.slice(oldPath.length) : p);
    const { selectedFile, history } = get();
    set({ history: history.map(rebase) });
    if (selectedFile && (selectedFile.path === oldPath || selectedFile.path.startsWith(prefix))) {
      await get().selectFile(rebase(selectedFile.path));
    }
  },

  deleteFolder: async (path) => {
    await invoke("delete_folder", { path });
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const { selectedFile, history } = get();
    if (selectedFile && (selectedFile.path === path || selectedFile.path.startsWith(prefix))) {
      set({ selectedFile: null });
    }
    set({ history: history.filter(p => p !== path && !p.startsWith(prefix)) });
    await get().fetchTree();
  },

  fetchVaultPath: async () => {
    try {
      const vaultPath = await invoke<string | null>("get_vault_path");
      set({ vaultPath });
    } catch {
      set({ vaultPath: null });
    }
  },

  setVaultPath: async (path) => {
    await invoke("set_vault_path", { path });
    set({ vaultPath: path });
    await get().fetchTree();
  },

  pickVaultFolder: async () => {
    const path = await invoke<string | null>("pick_vault_folder");
    return path;
  },

  toggleExpanded: (path) => {
    const next = new Set(get().expandedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ expandedPaths: next });
  },
}));
