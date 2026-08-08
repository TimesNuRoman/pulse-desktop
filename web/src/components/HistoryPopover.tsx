// SPDX-License-Identifier: Apache-2.0
// Pulse desktop - R248 history popover (Raycast pattern).
//
// R248 replaces R174's persistent left sidebar with a transient
// popover triggered by a [☰ History] button in the topbar. The
// popover carries the same data ChatSidebar did (chat summaries
// sorted by `lastMessageAt` desc, plus rename / delete affordances)
// but as a floating panel anchored to the button, not a 240px
// column that eats one third of the viewport.
//
// Why popover (not sidebar):
//   * Raycast ships a single column + a [⌘K] command palette. The
//     R241/R244 work already pushed the window chrome in that
//     direction; R248 removes the structural mismatch.
//   * Popover closes on Escape / click-outside / chat-pick so it
//     never lingers and never competes with chat for horizontal
//     real estate.
//
// Interaction contract:
//   * Tab/Shift-Tab and Down/Up arrows navigate the list
//   * Enter picks the focused row
//   * Escape closes
//   * Click on a row picks the chat AND closes the popover
//   * Click on [Rename] swaps the title into an inline <input> with
//     its own Enter/Escape handling — independent of the list
//     keyboard nav
//   * Click on [Delete] asks window.confirm then fires onDelete
//
// All chat persistence still lives in `lib/chatHistory.ts`. This
// component is dumb + controlled, same shape as the old ChatSidebar
// — parent owns data and side effects, the popover only renders.

import { useState, useEffect, useRef, useMemo, type KeyboardEvent } from 'react';
import type { ChatSummary } from '../lib/chatHistory';
import { EmptyState } from './EmptyState';

export interface HistoryPopoverProps {
  /** All chats sorted by `lastMessageAt` desc — parent pre-sorts. */
  chats: ChatSummary[];
  /** Id of the active chat (highlights the row). */
  currentId: string | null;
  /** Click handler — popover closes itself. */
  onSelect: (id: string) => void;
  /** Click handler — popover closes itself. */
  onNewChat: () => void;
  /** Click handler — popover stays open so the user can keep working. */
  onDelete: (id: string) => void;
  /** Click handler — popover stays open so the user can keep working. */
  onRename: (id: string, newTitle: string) => void;
  /** Popover close handler (Escape, click-outside, or chat-pick). */
  onClose: () => void;
}

const TITLE_MAX = 30;

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
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

export function HistoryPopover(props: HistoryPopoverProps) {
  const {
    chats,
    currentId,
    onSelect,
    onNewChat,
    onDelete,
    onRename,
    onClose,
  } = props;

  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  }, [chats, query]);

  // Keep focusIdx in range as the filtered list changes.
  useEffect(() => {
    if (focusIdx >= filtered.length) {
      setFocusIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered, focusIdx]);

  // Focus the rename input when entering rename mode.
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // Scroll the focused row into view when the focus index changes
  // via keyboard navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-history-idx="${focusIdx}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusIdx]);

  function startRename(id: string) {
    const chat = chats.find((c) => c.id === id);
    if (!chat) return;
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

  function pickByIndex(idx: number) {
    const c = filtered[idx];
    if (!c) return;
    onSelect(c.id);
  }

  function handleListKey(e: KeyboardEvent<HTMLUListElement>) {
    if (renamingId) return; // rename input owns its own keys
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setFocusIdx(Math.max(0, filtered.length - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pickByIndex(focusIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      ref={rootRef}
      className="history-popover"
      role="dialog"
      aria-modal="true"
      aria-label="История чатов"
      data-testid="history-popover"
    >
      <div className="history-popover__head">
        <button
          type="button"
          className="history-popover__new"
          onClick={onNewChat}
          title="Новый чат"
          aria-label="Новый чат"
          data-testid="history-new"
        >
          <span className="history-popover__new-plus" aria-hidden>
            +
          </span>
          <span className="history-popover__new-label">Новый чат</span>
        </button>
      </div>

      <div className="history-popover__search">
        <input
          type="text"
          className="history-popover__search-input"
          placeholder="Поиск…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Search input traps Escape so the popover still closes.
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          aria-label="Поиск по чатам"
          spellCheck={false}
          data-testid="history-search"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="history-popover__empty">
          <EmptyState
            title={query ? 'Ничего не найдено' : 'Нет сохранённых чатов'}
            hint={
              query
                ? `По запросу «${query.trim()}» совпадений нет`
                : 'Нажмите «Новый чат», чтобы начать'
            }
            testId="history-empty"
          />
        </div>
      ) : (
        <ul
          ref={listRef}
          className="history-popover__list"
          role="listbox"
          aria-label="Сохранённые чаты"
          tabIndex={0}
          onKeyDown={handleListKey}
          data-testid="history-list"
        >
          {filtered.map((c, idx) => {
            const isActive = c.id === currentId;
            const isFocused = idx === focusIdx;
            const isRenaming = c.id === renamingId;
            return (
              <li
                key={c.id}
                className={`history-popover__row ${isActive ? 'is-active' : ''} ${
                  isFocused ? 'is-focused' : ''
                }`}
                role="option"
                aria-selected={isActive}
                data-testid="history-row"
                data-chat-id={c.id}
                data-history-idx={idx}
                onClick={() => !isRenaming && pickByIndex(idx)}
                onMouseEnter={() => setFocusIdx(idx)}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    className="history-popover__rename"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        commitRename();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        cancelRename();
                      }
                    }}
                    onBlur={commitRename}
                    aria-label="Новое название чата"
                  />
                ) : (
                  <>
                    <div className="history-popover__row-title">
                      {truncate(c.title, TITLE_MAX)}
                    </div>
                    <div className="history-popover__row-meta">
                      <span className="history-popover__row-time">
                        {relativeTime(c.lastMessageAt)}
                      </span>
                      <span
                        className="history-popover__row-count"
                        aria-label={`${c.messageCount} сообщений`}
                      >
                        {c.messageCount}
                      </span>
                    </div>
                    <div className="history-popover__row-actions">
                      <button
                        type="button"
                        className="history-popover__row-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(c.id);
                        }}
                        title="Переименовать"
                        aria-label="Переименовать"
                        data-testid="history-row-rename"
                      >
                        rename
                      </button>
                      <button
                        type="button"
                        className="history-popover__row-btn history-popover__row-btn--danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          const label = c.title || 'этот чат';
                          if (
                            typeof window !== 'undefined' &&
                            window.confirm(`Удалить "${label}"?`)
                          ) {
                            onDelete(c.id);
                          }
                        }}
                        title="Удалить"
                        aria-label="Удалить"
                        data-testid="history-row-delete"
                      >
                        delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
