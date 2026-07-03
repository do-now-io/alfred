import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { VaultNode } from "../bindings/VaultNode";
import type { NoteFile } from "../bindings/NoteFile";
import type { NoteMetadata } from "../bindings/NoteMetadata";
import type { RecentNote } from "../bindings/RecentNote";

// Recursively search a VaultNode tree for a file whose stem matches `ref`
export function findNodeByRef(node: VaultNode, ref: string): string | null {
  if (!node.is_dir) {
    const stem = node.name; // already stripped of .md
    if (stem.toLowerCase() === ref.toLowerCase()) return node.path;
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
