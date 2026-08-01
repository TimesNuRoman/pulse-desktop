// Mirrors HabrItem / HabrSearchResult from pulse-desktop/src-tauri/src/lib.rs
// + Pulse v5 — AppInfo / GameInfo / ProcInfo / SysInfo (см. src-tauri/src/agent.rs).
// + YoutubeVideo / YoutubeLatestResult (см. src-tauri/src/youtube.rs).

export interface HabrItem {
  title: string;
  url: string;
  author: string;
  time: string;
  snippet: string;
}

export interface HabrSearchResult {
  query: string;
  total: number;
  items: HabrItem[];
  /** true если habr-search на :3000 недоступен */
  offline: boolean;
  /** подробности ошибки (если есть) */
  error: string | null;
}

/** Одно видео из YouTube RSS. Зеркало Rust `youtube::YoutubeVideo`. */
export interface YoutubeVideo {
  title: string;
  url: string;
  channel: string;
  /** RFC3339 (как в YouTube Atom). */
  published: string;
  thumbnail: string | null;
}

/** Результат `youtube_latest`. Зеркало Rust `youtube::YoutubeLatestResult`. */
export interface YoutubeLatestResult {
  query: string;
  /** Распознанный channel_id (если нашли). */
  channel_id: string | null;
  videos: YoutubeVideo[];
  /** Текст ошибки (если была) — для UI. */
  error: string | null;
}

/** Один результат общего web-поиска. Зеркало Rust-структуры SearchItem
 *  (src-tauri/src/web_search.rs). */
export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
  /** "general" | "wikipedia" */
  source: string;
  /** "Habr" | "Reddit" | "StackOverflow" | "GitHub" | "Wikipedia" | … */
  site_name: string;
}

/** Зеркало Rust `WebSearchResult` (src-tauri/src/web_search.rs). */
export interface WebSearchResult {
  query: string;
  /** Какой backend реально ответил: "ddg-html" | "ddg-lite" | "wikipedia" | "none". */
  backend: string;
  total: number;
  items: SearchItem[];
  offline: boolean;
  error: string | null;
}

export type Role = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: Role;
  /** сырой текст (может содержать markdown) */
  content: string;
  ts: number;
  /** для ассистента: ещё идёт генерация (стрим) */
  streaming?: boolean;
  /** прикреплённый скриншот (PNG в base64, без data: префикса) */
  imageBase64?: string;
  /** подпись к скриншоту */
  imageCaption?: string;
  /** прикреплённый файл через кнопку 📎: подпись (имя, размер) */
  attachmentCaption?: string;
  /** прикреплённый файл-картинка (data: URL, для inline-превью) */
  attachmentImageDataUrl?: string;
  /** сниппет текстового файла (≤5000 символов), показывается в code-блоке */
  attachmentTextSnippet?: string;
  /** полный путь к файлу — полезно для копирования/дебага, в UI не светится */
  attachmentPath?: string;
  /** Pulse v5: тул-колл, который ассистент выполнил (для bubble-лога) */
  toolCall?: ToolCall;
  /** Запрос, по которому автоматически был сделан web_search (UI-индикатор 🔍). */
  searchQuery?: string;
  /**
   * Внутреннее: LLM-контекст для этого сообщения (с <search_results> блоком).
   * В UI не рендерится — только подставляется в историю для LLM через
   * `toLLMMessages`. Не путать с `content` (это то, что видит юзер).
   */
  searchContext?: string;
  /**
   * R89: routing decision от Smart Engine v3 для ассистент-сообщений.
   * Если `routing.lowConfidence === true` — ChatView рисует chip над
   * контентом: "Smart Engine wasn't sure — routed to {routingMode}".
   * Юзер может кликнуть и переопределить routing для следующего промпта.
   * type-only re-import чтобы не тащить весь `route` сюда (избегаем циклов).
   */
  routing?: {
    preferredModel: string;
    fallbackModel: string;
    fired: string[];
    score: number;
    threshold: number;
    flipped: boolean;
    codeParseSignal: boolean;
    lowConfidence: boolean;
  };
  /** R89: human-readable routing mode ("CodeEdit" | "Vision" | "QuickAnswer" | "Reasoning" | "Default"). */
  routingMode?: 'CodeEdit' | 'Vision' | 'QuickAnswer' | 'Reasoning' | 'Default';
}

// ─── Pulse v5 — agentic AI ────────────────────────────────────────────────

/** Одна запись об установленном приложении. Зеркало Rust AppInfo. */
export interface AppInfo {
  name: string;
  path: string;
  version: string;
  /** registry | lnk | folder | package */
  source: string;
}

/** Запись об игре из лаунчера. Зеркало Rust GameInfo. */
export interface GameInfo {
  name: string;
  /** steam | epic | gog | battlenet */
  source: string;
  appid: string;
  install_path: string;
  last_played: number; // unix-ms
}

/** Запись о запущенном процессе. Зеркало Rust ProcInfo. */
export interface ProcInfo {
  pid: number;
  name: string;
  memory_mb: number;
  cpu_pct: number;
}

/** Диск. */
export interface DiskInfo {
  mount: string;
  total_gb: number;
  free_gb: number;
}

/** Системная информация. Зеркало Rust SysInfo. */
export interface SysInfo {
  cpu_brand: string;
  cpu_cores: number;
  cpu_usage_pct: number;
  ram_total_gb: number;
  ram_used_gb: number;
  disks: DiskInfo[];
  battery_pct: number | null;
  uptime_secs: number;
}

/** Результат launch_app. */
export interface LaunchResult {
  pid: number | null;
  kind: string;
}

/**
 * Тул-колл: что LLM попросила сделать + результат.
 * Живёт как «сообщение в чате» — `ChatMessage.role === 'assistant'`,
 * но рендерится отдельным bubble (chat__toolcall), а не текстом.
 */
export interface ToolCall {
  /** имя tool из реестра (list_installed_apps / find_app / launch_app / …) */
  tool: string;
  /** аргументы как они пришли от LLM (наш JSON-mode парсер восстанавливает) */
  args: Record<string, unknown>;
  /** результат выполнения (строка/JSON) — null пока в процессе */
  result: string | null;
  /** ошибка (если была) */
  error: string | null;
  /** «running» — выполняется прямо сейчас; null = готово */
  pending: boolean;
}
