// Thin wrappers around Tauri `invoke` для файловых команд из lib.rs.
// В dev-браузере без Tauri-runtime все функции кидают понятную ошибку.

import { invoke } from '@tauri-apps/api/core';
import type { FileInfo, ListDirResult, TextFileContent, SearchResult } from './types';

const IN_TAURI =
  typeof window !== 'undefined' &&
  (Boolean((window as any).__TAURI_INTERNALS__) || Boolean((window as any).__TAURI__));

function needTauri(op: string): void {
  if (!IN_TAURI) {
    throw new Error(`${op}: нужно Tauri-окружение (npm run tauri dev).`);
  }
}

export async function listDirectory(path: string): Promise<ListDirResult> {
  needTauri('list_directory');
  return invoke<ListDirResult>('list_directory', { path });
}

export async function fileInfo(path: string): Promise<FileInfo> {
  needTauri('file_info');
  return invoke<FileInfo>('file_info', { path });
}

export async function readTextFile(path: string): Promise<TextFileContent> {
  needTauri('read_text_file');
  return invoke<TextFileContent>('read_text_file', { path });
}

export async function searchFiles(
  root: string,
  query: string,
  maxResults = 50,
): Promise<SearchResult> {
  needTauri('search_files');
  return invoke<SearchResult>('search_files', { root, query, maxResults });
}

export async function openInExplorer(path: string): Promise<void> {
  needTauri('open_in_explorer');
  await invoke('open_in_explorer', { path });
}
