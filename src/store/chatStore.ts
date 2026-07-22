import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChatSource } from "../bindings/ChatSource";
import type { ChatMessage } from "../bindings/ChatMessage";
import type { ChatConversation } from "../bindings/ChatConversation";
import type { ChatExchangeResult } from "../bindings/ChatExchangeResult";
import type { StoredChatMessage } from "../bindings/StoredChatMessage";
import type { ProposedAction } from "../bindings/ProposedAction";

/** État LOCAL de résolution d'une action proposée (spec/22) — jamais
 *  persisté : une carte non résolue redevient "pending" si on rouvre la
 *  conversation (le pending_action lui-même n'est pas stocké en base). */
export type ActionState = "pending" | "applying" | "applied" | "cancelled" | "error";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  pendingAction?: ProposedAction | null;
  actionState?: ActionState;
  actionResult?: number;
  actionError?: string;
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
  /** Carte Appliquer/Annuler (spec/22) — appelle directement la commande
   *  Tauri, sans repasser par Claude (carte locale, esprit de /resolve). */
  applyAction: (turnId: string) => Promise<void>;
  cancelAction: (turnId: string) => void;
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
          {
            id: nextId(),
            role: "assistant",
            content: res.answer,
            sources: res.sources,
            pendingAction: res.pending_action,
            actionState: res.pending_action ? "pending" : undefined,
          },
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

  applyAction: async (turnId) => {
    const turn = get().messages.find(m => m.id === turnId);
    if (!turn?.pendingAction) return;
    set(state => ({
      messages: state.messages.map(m => (m.id === turnId ? { ...m, actionState: "applying" } : m)),
    }));
    try {
      const count = await invoke<number>("confirm_agent_action", { action: turn.pendingAction });
      set(state => ({
        messages: state.messages.map(m => (m.id === turnId ? { ...m, actionState: "applied", actionResult: count } : m)),
      }));
      // La mutation a pu toucher Notes/Tâches — les autres écrans écoutent
      // déjà notes-updated/todos-updated (émis côté back par la commande).
    } catch (e) {
      set(state => ({
        messages: state.messages.map(m => (m.id === turnId ? { ...m, actionState: "error", actionError: String(e) } : m)),
      }));
    }
  },

  cancelAction: (turnId) => {
    set(state => ({
      messages: state.messages.map(m => (m.id === turnId ? { ...m, actionState: "cancelled" } : m)),
    }));
  },
}));
