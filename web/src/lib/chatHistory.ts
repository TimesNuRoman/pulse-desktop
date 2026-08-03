// SPDX-License-Identifier: Apache-2.0
// Pulse — chat history persistence (R174 multi-chat tabs).
//
// Local-only CRUD over `localStorage`. No cloud sync (future PRO feature).
// Storage key: `pulse.chat.history.v1`. Schema:
//
//   {
//     chats: {
//       [id]: {
//         id: string,
//         title: string,
//         messages: ChatMessage[],
//         lastMessageAt: string  // ISO 8601
//       }
//     }
//   }
//
// Hard cap: 50 chats (FIFO eviction by oldest `lastMessageAt` when over).
// All read/write errors are swallowed — chat is a local cache, the UI must
// still work even if storage is broken (private browsing, quota, etc.).

import type { ChatMessage } from '../types';

const STORAGE_KEY = 'pulse.chat.history.v1';
const MAX_CHATS = 50;

export interface ChatSummary {
  id: string;
  title: string;
  lastMessageAt: string; // ISO 8601
  messageCount: number;
}

export interface StoredChat {
  id: string;
  title: string;
  messages: ChatMessage[];
  lastMessageAt: string; // ISO 8601
}

interface HistoryFile {
  chats: Record<string, StoredChat>;
}

function emptyFile(): HistoryFile {
  return { chats: {} };
}

function readFile(): HistoryFile {
  if (typeof localStorage === 'undefined') return emptyFile();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyFile();
    const parsed = JSON.parse(raw) as Partial<HistoryFile>;
    if (!parsed || typeof parsed !== 'object' || !parsed.chats) {
      return emptyFile();
    }
    return { chats: parsed.chats as Record<string, StoredChat> };
  } catch {
    return emptyFile();
  }
}

function writeFile(file: HistoryFile): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert one chat into history. Updates `lastMessageAt` to now.
 * Evicts the oldest chat by `lastMessageAt` if over `MAX_CHATS` (FIFO).
 * Returns true on success, false on storage failure (silent).
 */
export function saveChat(
  id: string,
  title: string,
  messages: ChatMessage[],
): boolean {
  const file = readFile();
  const now = new Date().toISOString();
  file.chats[id] = {
    id,
    title,
    messages,
    lastMessageAt: now,
  };
  // FIFO eviction: keep at most MAX_CHATS, drop oldest by lastMessageAt.
  const ids = Object.keys(file.chats);
  if (ids.length > MAX_CHATS) {
    const sorted = ids
      .map((cid) => ({ id: cid, ts: file.chats[cid].lastMessageAt }))
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const toEvict = sorted.slice(0, ids.length - MAX_CHATS);
    for (const e of toEvict) {
      delete file.chats[e.id];
    }
  }
  return writeFile(file);
}

/**
 * Return summary list, sorted by `lastMessageAt` desc. Chats with zero
 * messages are filtered out (no point listing an empty chat in the sidebar).
 */
export function loadAllChats(): ChatSummary[] {
  const file = readFile();
  const out: ChatSummary[] = [];
  for (const c of Object.values(file.chats)) {
    if (!c.messages || c.messages.length === 0) continue;
    out.push({
      id: c.id,
      title: c.title,
      lastMessageAt: c.lastMessageAt,
      messageCount: c.messages.length,
    });
  }
  out.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  return out;
}

/**
 * Load full conversation (messages) for a single id. Returns empty array
 * if id is unknown.
 */
export function loadChat(id: string): ChatMessage[] {
  const file = readFile();
  const c = file.chats[id];
  if (!c) return [];
  return c.messages;
}

/**
 * Remove a chat from history. No-op if id is unknown.
 */
export function deleteChat(id: string): void {
  const file = readFile();
  if (!(id in file.chats)) return;
  delete file.chats[id];
  writeFile(file);
}

/**
 * Update title of a single chat. Returns true on success, false if id
 * is unknown or storage failed.
 */
export function renameChat(id: string, newTitle: string): boolean {
  const file = readFile();
  const c = file.chats[id];
  if (!c) return false;
  c.title = newTitle;
  return writeFile(file);
}

/** @internal exposed for tests */
export const __TESTING__ = { STORAGE_KEY, MAX_CHATS };
