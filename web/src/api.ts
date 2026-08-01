import { invoke } from '@tauri-apps/api/core';
import type {
  HabrSearchResult,
  YoutubeLatestResult,
  AppInfo,
  GameInfo,
  ProcInfo,
  SysInfo,
  LaunchResult,
} from './types';
import { createStubSTTEngine } from './voice/stt';
import type { STTEngine } from './voice/stt';
import { createWebSpeechSTTEngine } from './voice/stt-web';

// ─── Runtime detection ─────────────────────────────────────────────────────
// Pulse работает в трёх средах:
//   1) Tauri v2 (desktop Win/Mac/Linux) — есть __TAURI_INTERNALS__ / __TAURI__
//   2) Capacitor (Android/iOS)            — есть window.Capacitor
//   3) Web-браузер (dev)                  — ничего из вышеперечисленного
//
// На Android рантайм — Capacitor, Tauri-инвока НЕ работает.
// Поэтому каждая функция имеет:
//   1) Tauri: invoke(...)  — приоритет
//   2) Capacitor / web:    — fallback (fetch, Browser.open, ...)

const IN_TAURI =
  typeof window !== 'undefined' &&
  (Boolean((window as any).__TAURI_INTERNALS__) || Boolean((window as any).__TAURI__));

const IN_CAPACITOR =
  typeof window !== 'undefined' && Boolean((window as any).Capacitor);

/** Запущено в Capacitor (мобильный WebView) */
export const IS_MOBILE = IN_CAPACITOR;

/** Запущено в Tauri (десктоп) */
export const IS_DESKTOP = IN_TAURI;

// ─── Capacitor plugin loaders (lazy) ────────────────────────────────────────
// Импортируем динамически: на desktop они не нужны и могут не бандлиться.
async function getCapacitorBrowser(): Promise<any | null> {
  if (!IN_CAPACITOR) return null;
  try {
    const m = await import('@capacitor/browser');
    return m.Browser;
  } catch {
    return null;
  }
}
async function getCapacitorCamera(): Promise<any | null> {
  if (!IN_CAPACITOR) return null;
  try {
    const m = await import('@capacitor/camera');
    return m.Camera;
  } catch {
    return null;
  }
}
async function getCapacitorApp(): Promise<any | null> {
  if (!IN_CAPACITOR) return null;
  try {
    const m = await import('@capacitor/app');
    return m.App;
  } catch {
    return null;
  }
}
async function getCapacitorKeyboard(): Promise<any | null> {
  if (!IN_CAPACITOR) return null;
  try {
    const m = await import('@capacitor/keyboard');
    return m.Keyboard;
  } catch {
    return null;
  }
}

/** Результат нативного скриншота через Rust-команду `capture_screen`. */
export interface ScreenShot {
  /** PNG в base64 (без data: префикса) */
  base64: string;
  /** путь к .png файлу во временной папке ОС (для Tauri); для Capacitor — '' */
  path: string;
  /** размер файла в байтах */
  bytes: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Достаём origin webview. Для Capacitor на Android — `https://localhost`,
 *  для dev-сервера — `http://localhost:5173`. Используется для fetch на
 *  habr-search (127.0.0.1:3000). */
function localBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  // В Capacitor WebView origin обычно `https://localhost` — fetch на
  // 127.0.0.1 сработает (это loopback), но mixed-content может резаться.
  // С `allowMixedContent: true` в capacitor.config — должно проходить.
  return window.location.origin || '';
}

/** Сообщение о недоступности Tauri-функции вне desktop. */
function desktopOnly(op: string): string {
  return `${op}: только в Tauri-десктопе. На мобильном недоступно.`;
}

// ─── searchHabr ────────────────────────────────────────────────────────────

/** Поиск по Хабру.
 *  1) Tauri: `invoke('search_habr')` — Rust-команда ходит в habr-search на :3000.
 *  2) Capacitor / web: прямой fetch на 127.0.0.1:3000 (тот же бэкенд).
 *     Требует, чтобы habr-search уже был запущен. CORS мы НЕ ставим — fetch
 *     с https://localhost на http://127.0.0.1:3000 проходит как cross-origin
 *     + mixed-content; allowMixedContent=true решает вторую часть.
 *     Если не сработает — вернём offline:true с понятной подсказкой.
 */
export async function searchHabr(query: string, limit = 15): Promise<HabrSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query: '', total: 0, items: [], offline: false, error: null };
  }
  if (IN_TAURI) {
    return invoke<HabrSearchResult>('search_habr', { query: trimmed, limit });
  }
  // Capacitor / web fallback
  try {
    const url = `http://127.0.0.1:3000/api/search?q=${encodeURIComponent(trimmed)}&limit=${limit}`;
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) {
      return {
        query: trimmed,
        total: 0,
        items: [],
        offline: true,
        error: `habr-search: HTTP ${r.status}`,
      };
    }
    const data = await r.json();
    // Бэкенд возвращает { items, total, query } — нормализуем
    return {
      query: data.query ?? trimmed,
      total: typeof data.total === 'number' ? data.total : (data.items?.length ?? 0),
      items: Array.isArray(data.items) ? data.items : [],
      offline: false,
      error: null,
    };
  } catch (e) {
    return {
      query: trimmed,
      total: 0,
      items: [],
      offline: true,
      error:
        `habr-search недоступен (${(e as Error).message}). ` +
        'Запусти бэкенд: `cd C:\\Users\\1\\.minimax-agent\\projects\\habr-search && npm run dev`.',
    };
  }
}

// ─── YouTube RSS fallback (для мобильного) ────────────────────────────────

/** YouTube channel_id из разных форматов входа:
 *  - @handle   → нужен HTML scrape → возвращаем null (без API-ключа никак)
 *  - URL вида https://www.youtube.com/channel/UCxxxx  → берём UCxxxx
 *  - URL вида https://www.youtube.com/@handle          → null
 *  - "UC..."   → как есть
 *  - всё остальное → null (поиск канала требует API-ключа)
 */
function extractChannelId(input: string): string | null {
  const s = input.trim();
  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  const m = s.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

/** Простой парсер YouTube Atom RSS через DOMParser. */
function parseYoutubeRss(xml: string, max: number): Array<{
  title: string;
  url: string;
  channel: string;
  published: string;
  thumbnail: string | null;
}> {
  if (typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const entries = Array.from(doc.getElementsByTagName('entry')).slice(0, max);
  const channelName =
    doc.getElementsByTagName('author')[0]?.getElementsByTagName('name')[0]?.textContent ?? '';
  return entries.map((e) => {
    const title = e.getElementsByTagName('title')[0]?.textContent ?? '';
    const link =
      e.getElementsByTagName('link')[0]?.getAttribute('href') ??
      e.getElementsByTagName('link')[0]?.textContent ??
      '';
    const published = e.getElementsByTagName('published')[0]?.textContent ?? '';
    const mediaGroup = e.getElementsByTagName('media:group')[0];
    const thumb =
      mediaGroup?.getElementsByTagName('media:thumbnail')[0]?.getAttribute('url') ?? null;
    return { title, url: link, channel: channelName, published, thumbnail: thumb };
  });
}

// ─── youtubeLatest ─────────────────────────────────────────────────────────

/** Последние видео с YouTube-канала.
 *  1) Tauri: invoke('youtube_latest') — Rust-парсер.
 *  2) Capacitor / web: прямой fetch RSS + DOMParser. Работает только если
 *     query — channel_id (UC...) или URL вида /channel/UC... . Handle (@user)
 *     и поиск по имени — без API-ключа не работают, вернём понятную ошибку.
 */
export async function youtubeLatest(
  query: string,
  max = 5,
): Promise<YoutubeLatestResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query: '', channel_id: null, videos: [], error: 'Пустой query.' };
  }
  if (IN_TAURI) {
    return invoke<YoutubeLatestResult>('youtube_latest', { query: trimmed, max });
  }
  // Capacitor / web fallback
  const channelId = extractChannelId(trimmed);
  if (!channelId) {
    return {
      query: trimmed,
      channel_id: null,
      videos: [],
      error:
        'На мобильном YouTube-поиск работает только по channel_id (UC...) или URL вида /channel/UC... . ' +
        'Handle (@user) и поиск по имени требуют YouTube API-ключа.',
    };
  }
  try {
    const r = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
    );
    if (!r.ok) {
      return {
        query: trimmed,
        channel_id: channelId,
        videos: [],
        error: `YouTube RSS: HTTP ${r.status}`,
      };
    }
    const xml = await r.text();
    const parsed = parseYoutubeRss(xml, max);
    return {
      query: trimmed,
      channel_id: channelId,
      videos: parsed,
      error: parsed.length === 0 ? 'Канал найден, но видео отсутствуют.' : null,
    };
  } catch (e) {
    return {
      query: trimmed,
      channel_id: channelId,
      videos: [],
      error: `YouTube RSS: ${(e as Error).message}`,
    };
  }
}

// ─── Window / tray controls (только Tauri) ─────────────────────────────────

/** Свернуть панель в трей. */
export async function hideWindow(): Promise<void> {
  if (!IN_TAURI) return; // на мобильном no-op
  await invoke('cmd_hide');
}

/** Показать панель из трея. */
export async function showWindow(): Promise<void> {
  if (!IN_TAURI) return;
  await invoke('cmd_show');
}

/** Toggle панели. */
export async function toggleWindow(): Promise<boolean> {
  if (!IN_TAURI) return false;
  return invoke<boolean>('cmd_toggle');
}

// ─── captureScreen ─────────────────────────────────────────────────────────

/** Снять скриншот.
 *  1) Tauri: invoke('capture_screen') — Rust + xcap.
 *  2) Capacitor: Camera.getPhoto() — НЕ настоящий скриншот, а фото с камеры
 *     или из галереи. Пользователь должен явно подтвердить (permission flow).
 *     Возвращаем base64 + примерный размер.
 *  3) Web: бросаем понятную ошибку (в браузере нет API для скриншота ОС).
 */
export async function captureScreen(): Promise<ScreenShot> {
  if (IN_TAURI) {
    return invoke<ScreenShot>('capture_screen');
  }
  if (IN_CAPACITOR) {
    const Camera = await getCapacitorCamera();
    if (!Camera) {
      throw new Error('Камера не доступна (плагин @capacitor/camera не загружен).');
    }
    try {
      // source: PROMPT — Capacitor покажет chooser (камера/галерея).
      const photo = await Camera.getPhoto({
        source: 'PROMPT',
        resultType: 'base64',
        quality: 70,
        allowEditing: false,
      });
      const base64 = photo.base64String ?? '';
      if (!base64) {
        throw new Error('Камера вернула пустой base64.');
      }
      // Грубая оценка размера в байтах (3/4 от длины base64)
      const bytes = Math.floor((base64.length * 3) / 4);
      return { base64, path: '', bytes };
    } catch (e) {
      throw new Error(`Камера: ${(e as Error).message}`);
    }
  }
  throw new Error('Скриншот ОС недоступен в обычном браузере.');
}

// ─── Autostart (только Tauri) ──────────────────────────────────────────────

export async function getAutostart(): Promise<boolean> {
  if (!IN_TAURI) return false; // на мобильном — нет автозапуска ОС
  return invoke<boolean>('get_autostart');
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (!IN_TAURI) return false;
  return invoke<boolean>('set_autostart', { enabled });
}

// ─── STT (работает везде через Web Speech API) ─────────────────────────────

/**
 * Выбрать STT-движок, доступный в текущем окружении.
 * Web Speech API работает и в Tauri WebView2, и в Capacitor WebView.
 * Если в WebView отключено — fallback на stub.
 */
export function getSTTEngine(lang = 'ru-RU'): STTEngine {
  if (
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  ) {
    return createWebSpeechSTTEngine({ lang });
  }
  return createStubSTTEngine();
}

// ─── Pulse v5 — agentic AI ────────────────────────────────────────────────

/** Список установленных приложений. Только Tauri. На мобильном — []. */
export async function listInstalledApps(): Promise<AppInfo[]> {
  if (!IN_TAURI) return [];
  return invoke<AppInfo[]>('list_installed_apps');
}

/** Поиск приложения по имени. Только Tauri. */
export async function findApp(query: string): Promise<AppInfo[]> {
  if (!IN_TAURI) return [];
  if (!query.trim()) return [];
  return invoke<AppInfo[]>('find_app', { query: query.trim() });
}

/** Запустить приложение. Только Tauri (нужна Windows API). */
export async function launchApp(path: string): Promise<LaunchResult> {
  if (!IN_TAURI) {
    return { pid: null, kind: 'unsupported' };
  }
  return invoke<LaunchResult>('launch_app', { path });
}

/** Список игр из Steam / Epic / GOG / Battle.net. Только Tauri. */
export async function listGames(): Promise<GameInfo[]> {
  if (!IN_TAURI) return [];
  return invoke<GameInfo[]>('list_games');
}

/** Top-50 процессов по памяти. Только Tauri. */
export async function listRunningProcesses(): Promise<ProcInfo[]> {
  if (!IN_TAURI) return [];
  return invoke<ProcInfo[]>('list_running_processes');
}

/** CPU / RAM / диски / uptime / батарея. Только Tauri. */
export async function systemInfo(): Promise<SysInfo> {
  if (!IN_TAURI) {
    return {
      cpu_brand: 'unknown',
      cpu_cores: 0,
      cpu_usage_pct: 0,
      ram_total_gb: 0,
      ram_used_gb: 0,
      disks: [],
      battery_pct: null,
      uptime_secs: 0,
    };
  }
  return invoke<SysInfo>('system_info');
}

// ─── openUrl ───────────────────────────────────────────────────────────────

/** Открыть URL во внешнем браузере / системном handler.
 *  1) Tauri: invoke('open_url') — дефолтный браузер.
 *  2) Capacitor: @capacitor/browser Browser.open — системный браузер.
 *  3) Web: window.open fallback (может быть заблокирован popup-блокером).
 */
export async function openUrl(url: string): Promise<void> {
  if (IN_TAURI) {
    await invoke('open_url', { url });
    return;
  }
  if (IN_CAPACITOR) {
    const Browser = await getCapacitorBrowser();
    if (Browser) {
      try {
        await Browser.open({ url });
        return;
      } catch {
        // fallback ниже
      }
    }
  }
  // web fallback
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ─── Capacitor-specific helpers (для App.tsx / ChatView) ───────────────────

/** Включить Capacitor.App backButton listener. Вызывать один раз из App. */
export async function setupCapacitorAppBackButton(handler: () => void): Promise<void> {
  const CapApp = await getCapacitorApp();
  if (!CapApp) return;
  try {
    await CapApp.addListener('backButton', handler);
  } catch {
    // ignore
  }
}

/** Включить Capacitor.Keyboard listeners. Вызывать один раз из App. */
export async function setupCapacitorKeyboard(): Promise<void> {
  const Keyboard = await getCapacitorKeyboard();
  if (!Keyboard) return;
  const setKbdH = (px: number) => {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty('--kbd-h', `${px}px`);
  };
  try {
    await Keyboard.addListener('keyboardWillShow', (info: any) => {
      setKbdH(info.keyboardHeight ?? 0);
    });
    await Keyboard.addListener('keyboardDidShow', (info: any) => {
      setKbdH(info.keyboardHeight ?? 0);
    });
    await Keyboard.addListener('keyboardWillHide', () => setKbdH(0));
    await Keyboard.addListener('keyboardDidHide', () => setKbdH(0));
  } catch {
    // ignore
  }
}

/** Выйти из приложения (Capacitor). */
export async function capExitApp(): Promise<void> {
  const CapApp = await getCapacitorApp();
  if (!CapApp) return;
  try {
    await CapApp.exitApp();
  } catch {
    // ignore
  }
}

/** Заглушка для старого `needTauri` — оставлена для совместимости с
 *  импортами в других файлах, но лучше не использовать. */
export function needTauri(op: string): never {
  throw new Error(desktopOnly(op));
}

// Используется для отладки в DevTools
export const _runtime = { IN_TAURI, IN_CAPACITOR, IS_MOBILE, IS_DESKTOP };
