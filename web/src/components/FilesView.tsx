// Файловый браузер (v4 MVP): path bar, list, preview, search, контекстное меню.

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import {
  listDirectory,
  fileInfo,
  searchFiles,
  openInExplorer,
} from '../files/filesApi';
import {
  type FileInfo,
  fileEmoji,
  formatSize,
  formatModified,
  getFileKind,
} from '../files/types';
import {
  buildAttachment,
  type Attachment,
} from '../files/attachments';

type Mode = 'list' | 'search';

interface ContextMenuState {
  x: number;
  y: number;
  info: FileInfo;
}

function dirname(p: string): string {
  // Простой parent: на Windows '\\' или '/'. Всё, что до последнего сепаратора.
  if (!p) return p;
  const norm = p.replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  if (idx < 0) return norm; // 'C:' → 'C:'
  if (idx === 0) return norm.slice(0, 1); // '/foo' → '/'
  // 'C:\\foo' → 'C:\\'
  if (idx === 2 && /[A-Z]:/i.test(norm.slice(0, 2))) return norm.slice(0, 3);
  return norm.slice(0, idx);
}

export function FilesView() {
  const [cwd, setCwd] = useState<string>('');
  const [entries, setEntries] = useState<FileInfo[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  // path bar
  const [pathDraft, setPathDraft] = useState('');

  // search
  const [searchMode, setSearchMode] = useState<Mode>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<FileInfo[]>([]);

  // context menu
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);
  const ctxRef = useRef<HTMLDivElement | null>(null);

  // инициальная загрузка: домашняя папка через Tauri path API
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { homeDir } = await import('@tauri-apps/api/path');
        const home = await homeDir();
        if (!cancelled) {
          setCwd(home);
          setPathDraft(home);
          await loadList(home);
        }
      } catch (e) {
        if (!cancelled) {
          setError(`Не удалось определить домашнюю папку: ${(e as Error).message}`);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // закрыть контекст-меню по клику вне / Escape
  useEffect(() => {
    if (!ctx) return;
    function onDoc(e: globalThis.MouseEvent) {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtx(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setCtx(null);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctx]);

  async function loadList(path: string) {
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const r = await listDirectory(path);
      setEntries(r.entries);
      setTruncated(r.truncated);
      setTotal(r.total);
      setCwd(path);
      setPathDraft(path);
      setSearchMode('list');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function onPathSubmit(e: FormEvent) {
    e.preventDefault();
    const p = pathDraft.trim();
    if (!p) return;
    await loadList(p);
  }

  async function onUp() {
    if (!cwd) return;
    const parent = dirname(cwd);
    if (parent && parent !== cwd) await loadList(parent);
  }

  async function onOpenEntry(info: FileInfo) {
    if (info.isDir) {
      await loadList(info.path);
      return;
    }
    setPreviewBusy(true);
    setError(null);
    try {
      const att = await buildAttachment(info);
      setPreview(att);
    } catch (e) {
      setError(`Превью: ${(e as Error).message}`);
    } finally {
      setPreviewBusy(false);
    }
  }

  function onContext(e: MouseEvent, info: FileInfo) {
    e.preventDefault();
    // Клампим к границам viewport
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 80);
    setCtx({ x, y, info });
  }

  async function onContextReveal() {
    if (!ctx) return;
    const p = ctx.info.path;
    setCtx(null);
    try {
      await openInExplorer(p);
    } catch (e) {
      setError(`Проводник: ${(e as Error).message}`);
    }
  }

  async function onContextCopyPath() {
    if (!ctx) return;
    const p = ctx.info.path;
    setCtx(null);
    try {
      // Tauri v2: используем плагин clipboard-manager (Web API `navigator.clipboard`
      // в Tauri WebView часто заблокирован и кидает `NotAllowedError`).
      await writeText(p);
    } catch {
      // ignore — clipboard может быть недоступен
    }
  }

  async function onContextPreview() {
    if (!ctx) return;
    const info = ctx.info;
    setCtx(null);
    if (info.isDir) {
      await loadList(info.path);
    } else {
      await onOpenEntry(info);
    }
  }

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q || !cwd) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const r = await searchFiles(cwd, q, 100);
      setSearchHits(r.hits);
      setSearchMode('search');
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function backToList() {
    setSearchMode('list');
    setSearchQuery('');
  }

  return (
    <div className="files">
      {/* Path bar */}
      <form className="files__pathbar" onSubmit={onPathSubmit}>
        <button
          type="button"
          className="files__iconbtn"
          onClick={() => void onUp()}
          title="На уровень вверх"
          aria-label="Вверх"
          disabled={!cwd}
        >
          ↑
        </button>
        <input
          className="files__path"
          type="text"
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          placeholder="Путь…"
          spellCheck={false}
        />
        <button
          type="submit"
          className="files__iconbtn files__iconbtn--accent"
          title="Перейти"
          disabled={loading}
        >
          ↵
        </button>
      </form>

      {/* Search */}
      <form className="files__searchbar" onSubmit={onSearch}>
        {searchMode === 'search' ? (
          <button
            type="button"
            className="files__iconbtn"
            onClick={backToList}
            title="К списку"
          >
            ←
          </button>
        ) : (
          <span className="files__searchhint">🔍</span>
        )}
        <input
          className="files__search"
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={`Поиск по имени в ${cwd || '…'}`}
          spellCheck={false}
        />
        <button
          type="submit"
          className="files__iconbtn"
          title="Найти"
          disabled={!searchQuery.trim() || !cwd || loading}
        >
          {loading ? '…' : '🔎'}
        </button>
      </form>

      {error && <div className="files__error">⚠ {error}</div>}

      <div className="files__body">
        {/* List */}
        <ul className="files__list" onContextMenu={(e) => e.preventDefault()}>
          {searchMode === 'list' && (
            <>
              {entries.length === 0 && !loading && !error && (
                <li className="files__empty">Папка пуста.</li>
              )}
              {entries.map((it) => (
                <li
                  key={it.path}
                  className="files__row"
                  onClick={() => void onOpenEntry(it)}
                  onContextMenu={(e) => onContext(e, it)}
                >
                  <span className="files__ico">{fileEmoji(it)}</span>
                  <span className="files__name" title={it.name}>{it.name}</span>
                  <span className="files__size">{it.isDir ? '—' : formatSize(it.size)}</span>
                  <span className="files__mtime">{formatModified(it.modified)}</span>
                </li>
              ))}
              {truncated && (
                <li className="files__trunc">
                  ⚠ Показано {entries.length} из {total}. Сужай диапазон.
                </li>
              )}
            </>
          )}
          {searchMode === 'search' && (
            <>
              <li className="files__trunc">Найдено: {searchHits.length}</li>
              {searchHits.map((it) => (
                <li
                  key={it.path}
                  className="files__row"
                  onClick={() => void onOpenEntry(it)}
                  onContextMenu={(e) => onContext(e, it)}
                >
                  <span className="files__ico">{fileEmoji(it)}</span>
                  <span className="files__name" title={it.path}>
                    {it.name}
                    <span className="files__pathhint"> — {it.path}</span>
                  </span>
                  <span className="files__size">{it.isDir ? '—' : formatSize(it.size)}</span>
                  <span className="files__mtime">{formatModified(it.modified)}</span>
                </li>
              ))}
              {searchHits.length === 0 && !loading && (
                <li className="files__empty">Ничего не нашлось.</li>
              )}
            </>
          )}
        </ul>

        {/* Preview pane */}
        <div className="files__preview">
          {previewBusy && <div className="files__previewempty">⏳ читаю…</div>}
          {!previewBusy && !preview && (
            <div className="files__previewempty">
              👈 Кликни по файлу, чтобы увидеть превью.
              <br />
              <span className="files__previewhint">
                Текст / код — сниппет (≤5000 символов). Картинка — inline. Остальное — метаданные.
              </span>
            </div>
          )}
          {preview && (
            <div className="files__previewinner" data-kind={preview.kind}>
              <div className="files__previewhead">
                <span>{fileEmoji(preview.info)} {preview.info.name}</span>
                <span className="files__previewmeta">
                  {preview.info.isDir ? 'папка' : formatSize(preview.info.size)} · {formatModified(preview.info.modified)}
                </span>
              </div>
              {preview.kind === 'image' && preview.imageDataUrl && (
                <img className="files__previewimg" src={preview.imageDataUrl} alt={preview.info.name} />
              )}
              {preview.kind === 'text' && preview.textSnippet && (
                <pre className="files__previewpre"><code>{preview.textSnippet}</code></pre>
              )}
              {preview.kind === 'video' && <div className="files__previewempty">🎬 Видео — превью недоступно (v4 MVP)</div>}
              {preview.kind === 'audio' && <div className="files__previewempty">🎵 Аудио — превью недоступно (v4 MVP)</div>}
              {(preview.kind === 'binary' || preview.kind === 'pdf') && !preview.textSnippet && (
                <div className="files__previewempty">📦 Бинарный / PDF — метаданные выше.</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {ctx && (
        <div
          ref={ctxRef}
          className="files__ctx"
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={() => void onContextPreview()}>
            {ctx.info.isDir ? '📂 Открыть' : '👁 Превью'}
          </button>
          <button type="button" onClick={() => void onContextReveal()}>
            📁 Открыть в проводнике
          </button>
          <button type="button" onClick={() => void onContextCopyPath()}>
            📋 Копировать путь
          </button>
        </div>
      )}
    </div>
  );
}
