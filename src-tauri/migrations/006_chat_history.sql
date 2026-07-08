-- Chat history (spec/10): conversations are app state, not vault content.
-- Title = first question (truncated) — set at creation.

CREATE TABLE chat_conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    sources_json    TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX idx_chat_messages_conversation ON chat_messages (conversation_id, created_at);
CREATE INDEX idx_chat_conversations_updated ON chat_conversations (updated_at DESC);
