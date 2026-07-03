import { useState } from "react";
import { useTodoStore } from "../store/todoStore";
import type { Todo } from "../bindings/Todo";

interface Props {
  todo: Todo;
}

export default function TodoItem({ todo }: Props) {
  const { completeTodo, dismissTodo, updateTodo } = useTodoStore();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [dueDate, setDueDate] = useState(todo.due_date ?? "");

  const handleComplete = () => {
    completeTodo(todo.id);
  };

  const handleSave = () => {
    updateTodo(todo.id, { title, due_date: dueDate || null });
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{
            width: "100%",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 14,
            background: "var(--card-bg)",
            color: "var(--text-primary)",
            marginBottom: 6,
          }}
        />
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 13,
            background: "var(--card-bg)",
            color: "var(--text-secondary)",
            marginBottom: 6,
          }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handleSave}
            style={{
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Enregistrer
          </button>
          <button
            onClick={() => setEditing(false)}
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Annuler
          </button>
          <button
            onClick={() => dismissTodo(todo.id)}
            style={{
              background: "transparent",
              color: "var(--danger)",
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              marginLeft: "auto",
            }}
          >
            Ignorer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "8px 0",
        borderBottom: "1px solid var(--border)",
        cursor: "pointer",
      }}
      onClick={() => setEditing(true)}
    >
      <input
        type="checkbox"
        style={{ marginTop: 2, cursor: "pointer", flexShrink: 0 }}
        onClick={(e) => {
          e.stopPropagation();
          handleComplete();
        }}
        readOnly
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {todo.title}
        </div>
        {todo.due_date && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            {todo.due_date}
          </div>
        )}
      </div>
    </div>
  );
}
