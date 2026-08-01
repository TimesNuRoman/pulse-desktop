// Mirrors FileInfo / ListDirResult / TextFileContent / SearchResult
// from pulse-desktop/src-tauri/src/lib.rs (Rust struct field names use snake_case,
// Tauri v2 auto-converts to camelCase on the JS side).

export interface FileInfo {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  /** bytes; 0 для папок */
  size: number;
  /** unix-ms, либо null если FS не вернула (FAT на флешке) */
  modified: number | null;
}

export interface ListDirResult {
  entries: FileInfo[];
  /** true если в каталоге >1000 элементов и мы обрезали */
  truncated: boolean;
  /** всего элементов в каталоге (включая обрезанные) */
  total: number;
}

export interface TextFileContent {
  path: string;
  content: string;
  size: number;
  /** сейчас всегда false (5 МБ лимит ужесточенный на бэке),
   *  поле оставлено на будущее, чтобы фронт мог отличить truncate от ошибки. */
  truncated: boolean;
}

export interface SearchResult {
  query: string;
  root: string;
  hits: FileInfo[];
  truncated: boolean;
}

/** Категория файла для UI — решает, как показать превью. */
export type FileKind = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'binary';

/** Грубая эвристика по расширению. Можно потом усложнить (magic bytes), но для MVP — норм. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a']);
const TEXT_EXT = new Set([
  // «сырой» текст
  'txt', 'md', 'log', 'csv', 'tsv', 'rtf',
  // код/конфиги
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
  'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'rs', 'py', 'rb', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql',
  'env', 'gitignore', 'gitattributes', 'editorconfig', 'lock',
  'svelte', 'vue',
]);

export function getFileKind(nameOrPath: string): FileKind {
  const dot = nameOrPath.lastIndexOf('.');
  if (dot < 0) return 'binary';
  const ext = nameOrPath.slice(dot + 1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'binary';
}

/** Иконка для списка (только категория — не цвет). */
export function fileEmoji(info: FileInfo | { isDir: boolean; name: string }): string {
  if (info.isDir) return '📁';
  const k = getFileKind(info.name);
  switch (k) {
    case 'image': return '🖼️';
    case 'video': return '🎬';
    case 'audio': return '🎵';
    case 'pdf':   return '📕';
    case 'text':  return '📄';
    default:      return '📦';
  }
}

/** Человекочитаемый размер: 1.2 КБ / 3.4 МБ / 1.1 ГБ. */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Локальная дата-время из unix-ms; null → '—'. */
export function formatModified(ms: number | null): string {
  if (ms == null) return '—';
  try {
    const d = new Date(ms);
    return d.toLocaleString('ru-RU', {
      year: '2-digit', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}
