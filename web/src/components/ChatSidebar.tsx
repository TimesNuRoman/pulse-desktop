// SPDX-License-Identifier: Apache-2.0
// Pulse — chat history sidebar (R174 multi-chat tabs).
//
// Dumb, controlled component. Reads nothing from localStorage itself —
// the parent (ChatView) owns the data and persistence. Keeps the
// component easy to test and lets the parent control when to refresh.
//
// Features:
//   * "New chat" button at the top
//   * Search/filter input (case-insensitive substring match on title
//     and last message preview)
//   * Conversation list, sorted by `lastMessageAt` desc (parent
//     pre-sorts)
//   * Active row highlighted with `aria-current="page"`
//   * Right-click context menu: Rename / Delete
//   * Collapse toggle (Ctrl+B shortcut is wired in the parent — this
//     component only emits `onToggle`)

import { useState, useEffect, useRef, useMemo } from 'react';
import type { ChatSummary } from '../lib/chatHistory';

interface ChatSidebarProps {
  chats: ChatSummary[];
  /** Currently active chat id, or null if a fresh empty conversation. */
  currentId: string | null;
  isCollapsed: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onToggle: () => void;
}

const TITLE_MAX = 30;
const PREVIEW_MAX = 40;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/** "5m ago" / "3h ago" / "yesterday" / "2d ago" / "Jan 5". */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const now = Date.now();
  const diff = now - t;
  if (diff < 0) return 'now';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  // Older — show short date
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ChatSidebar(props: ChatSidebarProps) {
  const {
    chats,
    currentId,
    isCollapsed,
    onSelect,
    onNewChat,
    onDelete,
    onRename,
    onToggle,
  } = props;

  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // Click-outside closes the context menu
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuFor(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  // Focus the rename input when entering rename mode
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  }, [chats, query]);

  function handleContextMenu(e: React.MouseEvent, id: string) {
    e.preventDefault();
    setMenuFor({ id, x: e.clientX, y: e.clientY });
  }

  function startRename(id: string) {
    const chat = chats.find((c) => c.id === id);
    if (!chat) return;
    setMenuFor(null);
    setRenamingId(id);
    setRenameValue(chat.title);
  }

  function commitRename() {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameValue('');
  }

  function handleDelete(id: string) {
    setMenuFor(null);
    // Simple confirm — no extra modal
    const chat = chats.find((c) => c.id === id);
    const label = chat?.title || 'этот чат';
    if (typeof window !== 'undefined' && window.confirm(`Удалить "${label}"?`)) {
      onDelete(id);
    }
  }

  if (isCollapsed) {
    return (
      <aside
        className="chatside chatside--collapsed"
        aria-label="История чатов"
        data-testid="chat-sidebar"
      >
        <button
          type="button"
          className="chatside__expand"
          onClick={onToggle}
          title="Показать историю чатов (Ctrl+B)"
          aria-label="Показать историю чатов"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden
          >
            <path
              d="M5 3L9 7L5 11"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="chatside"
      aria-label="История чатов"
      data-testid="chat-sidebar"
    >
      <div className="chatside__head">
        <button
          type="button"
          className="chatside__new"
          onClick={onNewChat}
          title="Новый чат"
          aria-label="Новый чат"
        >
          <span className="chatside__new-plus" aria-hidden>+</span>
          <span className="chatside__new-label">Новый чат</span>
        </button>
        <button
          type="button"
          className="chatside__collapse"
          onClick={onToggle}
          title="Скрыть историю (Ctrl+B)"
          aria-label="Скрыть историю чатов"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden
          >
            <path
              d="M9 3L5 7L9 11"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="chatside__search">
        <input
          type="text"
          className="chatside__search-input"
          placeholder="Поиск…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Поиск по чатам"
          spellCheck={false}
        />
      </div>

      <nav
        className="chatside__list"
        role="navigation"
        aria-label="Сохранённые чаты"
      >
        {filtered.length === 0 ? (
          <div className="chatside__empty">
            {query ? 'Ничего не найдено' : 'Нет сохранённых чатов'}
          </div>
        ) : (
          filtered.map((c) => {
            const isActive = c.id === currentId;
            const isRenaming = c.id === renamingId;
            return (
              <div
                key={c.id}
                className={`chatside__row ${isActive ? 'is-active' : ''}`}
                onClick={() => !isRenaming && onSelect(c.id)}
                onContextMenu={(e) => handleContextMenu(e, c.id)}
                role="link"
                aria-current={isActive ? 'page' : undefined}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (!isRenaming && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onSelect(c.id);
                  }
                }}
                data-testid="chat-row"
                data-chat-id={c.id}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    className="chatside__rename"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    onBlur={commitRename}
                    aria-label="Новое название чата"
                  />
                ) : (
                  <>
                    <div className="chatside__row-title">{truncate(c.title, TITLE_MAX)}</div>
                    <div className="chatside__row-meta">
                      <span className="chatside__row-time">
                        {relativeTime(c.lastMessageAt)}
                      </span>
                      <span className="chatside__row-count" aria-label={`${c.messageCount} сообщений`}>
                        {c.messageCount}
                      </span>
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </nav>

      {menuFor && (
        <div
          ref={menuRef}
          className="chatside__menu"
          style={{ top: menuFor.y, left: menuFor.x }}
          role="menu"
          data-testid="context-menu"
        >
          <button
            type="button"
            className="chatside__menu-item"
            role="menuitem"
            onClick={() => startRename(menuFor.id)}
            data-testid="menu-rename"
          >
            Переименовать
          </button>
          <button
            type="button"
            className="chatside__menu-item chatside__menu-item--danger"
            role="menuitem"
            onClick={() => handleDelete(menuFor.id)}
            data-testid="menu-delete"
          >
            Удалить
          </button>
        </div>
      )}
    </aside>
  );
}
