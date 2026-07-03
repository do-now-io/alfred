import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChatResponse } from "../bindings/ChatResponse";
import type { ChatSource } from "../bindings/ChatSource";
import type { ChatMessage } from "../bindings/ChatMessage";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
}

interface ChatStore {
  messages: ChatTurn[];
  loading: boolean;
  progress: string[]; // live 🔎/📄 steps of the in-flight request
  error: string | null;

  send: (question: string) => Promise<void>;
  clear: () => void;
}

let seq = 0;
const nextId = () => `${Date.now()}-${seq++}`;

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  loading: false,
  progress: [],
  error: null,

  send: async (question) => {
    const q = question.trim();
    if (!q || get().loading) return;

    // History is the conversation so far, before this question.
    const history: ChatMessage[] = get().messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    set(state => ({
      messages: [...state.messages, { id: nextId(), role: "user", content: q }],
      loading: true,
      progress: [],
      error: null,
    }));

    // Live progress emitted by the backend agentic loop.
    const unlisten = await listen<{ kind: string; label: string }>("chat-progress", (e) => {
      const { kind, label } = e.payload;
      const line = kind === "read" ? `📄 ${label}` : `🔎 ${label}`;
      set(state => ({ progress: [...state.progress, line] }));
    });

    try {
      const res = await invoke<ChatResponse>("ask_notes", { question: q, history });
      set(state => ({
        messages: [
          ...state.messages,
          { id: nextId(), role: "assistant", content: res.answer, sources: res.sources },
        ],
      }));
    } catch (err) {
      set({ error: String(err) });
    } finally {
      unlisten();
      set({ loading: false, progress: [] });
    }
  },

  clear: () => set({ messages: [], progress: [], error: null }),
}));
