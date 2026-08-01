// Логика прикрепления файла к чату: классификация + чтение контента.
// Используется ChatView (кнопка 📎) и FilesView (превью выбранного файла).

import { convertFileSrc } from '@tauri-apps/api/core';
import { getFileKind, formatSize, type FileKind } from './types';
import type { FileInfo } from './types';
import { fileInfo, readTextFile } from './filesApi';

/** Готовый «attachment» для отправки в чат (см. ChatMessage). */
export interface Attachment {
  info: FileInfo;
  kind: FileKind;
  /** Текстовый контент (≤5000 символов), null для не-текстовых. */
  textSnippet: string | null;
  /** data: URL для inline-превью картинки, null для остальных. */
  imageDataUrl: string | null;
  /** Подпись (для UI). */
  caption: string;
}

const TEXT_PREVIEW_LIMIT = 5000;

/** Прочитать файл и подготовить Attachment. */
export async function loadAttachment(path: string): Promise<Attachment> {
  const info = await fileInfo(path);
  return buildAttachment(info);
}

/** Уже зная FileInfo (например из listDirectory), просто дочитать контент. */
export async function buildAttachment(info: FileInfo): Promise<Attachment> {
  const kind = getFileKind(info.name);
  let textSnippet: string | null = null;
  let imageDataUrl: string | null = null;

  if (info.isFile) {
    if (kind === 'text') {
      try {
        const r = await readTextFile(info.path);
        textSnippet = r.content.length > TEXT_PREVIEW_LIMIT
          ? r.content.slice(0, TEXT_PREVIEW_LIMIT) + `\n\n…[обрезано, всего ${r.content.length} символов]`
          : r.content;
      } catch (e) {
        textSnippet = `⚠ не удалось прочитать: ${(e as Error).message}`;
      }
    } else if (kind === 'image') {
      // Tauri v2: convertFileSrc превращает абсолютный путь в asset:// URL,
      // который <img> понимает. Это безопаснее, чем file:// (CSP и WebView).
      const assetUrl = convertFileSrc(info.path);
      // Подтянуть через fetch и сделать data: URL — чтобы работало и в
      // простом <img src=...>, и в markdown-рендере без CSP-исключений.
      try {
        const r = await fetch(assetUrl);
        const blob = await r.blob();
        imageDataUrl = await blobToDataUrl(blob);
      } catch {
        // fallback — оставим null, UI покажет имя файла
        imageDataUrl = null;
      }
    }
  }

  const sizeStr = info.isDir ? '' : ` · ${formatSize(info.size)}`;
  const kindLabel = kind === 'image' ? '🖼️' : kind === 'text' ? '📄' : kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : kind === 'pdf' ? '📕' : '📎';
  const caption = `${kindLabel} ${info.name}${sizeStr}`;

  return { info, kind, textSnippet, imageDataUrl, caption };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Текст для отправки в LLM: краткое summary (для non-text) или код-блок (для text). */
export function attachmentToPromptBlock(att: Attachment): string {
  if (att.kind === 'text' && att.textSnippet) {
    const lang = guessLangFromName(att.info.name);
    return `Содержимое файла \`${att.info.name}\` (${formatSize(att.info.size)}):\n\n\`\`\`${lang}\n${att.textSnippet}\n\`\`\``;
  }
  if (att.kind === 'image' && att.imageDataUrl) {
    return `Прикреплено изображение \`${att.info.name}\` (${formatSize(att.info.size)}).`;
  }
  return `Прикреплён файл \`${att.info.name}\` (${att.kind}, ${formatSize(att.info.size)}).`;
}

function guessLangFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = name.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', json: 'json',
    rs: 'rust', py: 'python', rb: 'ruby', go: 'go', java: 'java',
    html: 'html', css: 'css', scss: 'scss', md: 'markdown',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', sql: 'sql',
    sh: 'bash', bash: 'bash', ps1: 'powershell', bat: 'batch',
  };
  return map[ext] ?? '';
}
