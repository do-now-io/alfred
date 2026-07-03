import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Todo } from "../bindings/Todo";
import type { CreateTodoInput } from "../bindings/CreateTodoInput";

interface TodoStore {
  todos: Todo[];
  fetchTodos: () => Promise<void>;
  createTodo: (input: CreateTodoInput) => Promise<void>;
  completeTodo: (id: string) => Promise<void>;
  dismissTodo: (id: string) => Promise<void>;
  updateTodo: (id: string, input: Partial<CreateTodoInput>) => Promise<void>;
}

export const useTodoStore = create<TodoStore>((set, get) => ({
  todos: [],

  fetchTodos: async () => {
    try {
      const todos = await invoke<Todo[]>("get_todos");
      set({ todos });
    } catch (e) {
      console.error("Failed to fetch todos:", e);
    }
  },

  createTodo: async (input) => {
    try {
      const todo = await invoke<Todo>("create_todo", { input });
      set({ todos: [...get().todos, todo] });
    } catch (e) {
      console.error("Failed to create todo:", e);
    }
  },

  completeTodo: async (id) => {
    set({ todos: get().todos.filter((t) => t.id !== id) });
    try {
      await invoke("complete_todo", { id });
    } catch (e) {
      console.error("Failed to complete todo:", e);
      get().fetchTodos();
    }
  },

  dismissTodo: async (id) => {
    set({ todos: get().todos.filter((t) => t.id !== id) });
    try {
      await invoke("dismiss_todo", { id });
    } catch (e) {
      console.error("Failed to dismiss todo:", e);
      get().fetchTodos();
    }
  },

  updateTodo: async (id, input) => {
    try {
      const todo = await invoke<Todo>("update_todo", { id, input });
      set({ todos: get().todos.map((t) => (t.id === id ? todo : t)) });
    } catch (e) {
      console.error("Failed to update todo:", e);
    }
  },
}));
