import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChatSource } from "../bindings/ChatSource";
import type { ChatMessage } from "../bindings/ChatMessage";
import type { ChatConversation } from "../bindings/ChatConversation";
import type { ChatExchangeResult } from "../bindings/ChatExchangeResult";
import type { StoredChatMessage } from "../bindings/StoredChatMessage";

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

  /** Conversation the current thread belongs to — null until the first exchange. */
  conversationId: string | null;
  /** Past conversations, most recently active first (spec/10 second-level nav). */
  conversations: ChatConversation[];

  send: (question: string) => Promise<void>;
  clear: () => void;
  fetchConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
}

let seq = 0;
const nextId = () => `${Date.now()}-${seq++}`;

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  loading: false,
  progress: [],
  error: null,
  conversationId: null,
  conversations: [],

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
      const res = await invoke<ChatExchangeResult>("ask_notes", {
        question: q,
        history,
        conversationId: get().conversationId,
      });
      set(state => ({
        messages: [
          ...state.messages,
          { id: nextId(), role: "assistant", content: res.answer, sources: res.sources },
        ],
        conversationId: res.conversation_id || state.conversationId,
      }));
      // The exchange just created/bumped a conversation — refresh the list.
      get().fetchConversations();
    } catch (err) {
      set({ error: String(err) });
    } finally {
      unlisten();
      set({ loading: false, progress: [] });
    }
  },

  clear: () => set({ messages: [], progress: [], error: null, conversationId: null }),

  fetchConversations: async () => {
    try {
      const conversations = await invoke<ChatConversation[]>("list_chat_conversations");
      set({ conversations });
    } catch (e) {
      console.error("list_chat_conversations failed:", e);
    }
  },

  openConversation: async (id) => {
    if (get().loading) return;
    try {
      const stored = await invoke<StoredChatMessage[]>("get_chat_messages", { conversationId: id });
      set({
        conversationId: id,
        messages: stored.map(m => ({
          id: m.id,
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
          sources: m.sources ?? undefined,
        })),
        error: null,
        progress: [],
      });
    } catch (e) {
      console.error("get_chat_messages failed:", e);
    }
  },

  deleteConversation: async (id) => {
    try {
      await invoke("delete_chat_conversation", { conversationId: id });
      set(state => ({
        conversations: state.conversations.filter(c => c.id !== id),
        // Deleting the open thread also clears the pane.
        ...(state.conversationId === id ? { conversationId: null, messages: [] } : {}),
      }));
    } catch (e) {
      console.error("delete_chat_conversation failed:", e);
    }
  },
}));
