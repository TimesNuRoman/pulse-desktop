// SPDX-License-Identifier: Apache-2.0
// Pulse R175 — Web-side hardware detector.
//
// Назначение: достать из браузера / Tauri-WebView / Capacitor-WebView то, что
// доступно через web APIs — CPU cores, RAM, GPU (через WebGL), OS, screen,
// язык. Это НЕ дубликат Tauri-команды `detect_hardware`: Rust даёт точные
// CPU brand / RAM total / disk free / OS kernel (через sysinfo + os_info),
// а web даёт GPU renderer string (которого в MVP у Rust нет — `gpus: []`),
// screen DPI, language. UI мерджит оба источника.
//
// Graceful fallback: каждое поле проверяется отдельно. Если API нет —
// возвращаем 'unknown' / null / 0. Функция НИКОГДА не бросает.
//
// Используется в Settings → About → «Your hardware» (R175).
// Не путать с `api.ts::detectHardware()` — та дёргает Tauri-инвок.

export interface CpuProbe {
  /** navigator.hardwareConcurrency, 'unknown' если API нет. */
  cores: number | 'unknown';
  /** Модель CPU из UA / WebGL — обычно только бренд или "unknown".
   *  Точное имя берёт Tauri-команда `detect_hardware` (sysinfo). */
  model: string;
}

export interface GpuProbe {
  vendor: string;
  renderer: string;
}

export interface ScreenProbe {
  width: number;
  height: number;
  /** devicePixelRatio (1 = стандартный, 2 = Retina, 1.5 = Windows scaling 150%). */
  dpi: number;
}

export interface HardwareInfo {
  cpu: CpuProbe;
  /** navigator.deviceMemory (ГБ). Округлено браузером до 0.25/0.5/1. */
  ram: number | 'unknown';
  /** null если WebGL недоступен или нет WEBGL_debug_renderer_info. */
  gpu: GpuProbe | null;
  /** navigator.userAgentData?.platform || navigator.platform || 'unknown'. */
  os: string;
  /** Зарезервировано под Tauri — в web API нет. */
  disk: 'unknown';
  screen: ScreenProbe;
  /** navigator.language || 'unknown'. */
  language: string;
}

/** Безопасный read navigator-полей. На сервере / без window — возвращает fallback. */
function safeNav(): Navigator | null {
  if (typeof navigator === 'undefined') return null;
  return navigator;
}

/** Достаём GPU vendor + renderer через WebGL. Если WebGL нет или
 *  WEBGL_debug_renderer_info extension не подгрузилась — null. */
function detectGpu(): GpuProbe | null {
  if (typeof document === 'undefined') return null;
  let canvas: HTMLCanvasElement | null = document.createElement('canvas');
  let gl: WebGLRenderingContext | null = null;
  try {
    // Пробуем оба контекста: webgl2 → webgl. На некоторых VM webgl2 не
    // инициализируется, но classic webgl работает.
    gl =
      (canvas.getContext('webgl2') as WebGLRenderingContext | null) ||
      (canvas.getContext('webgl') as WebGLRenderingContext | null) ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
  } catch {
    gl = null;
  } finally {
    // Чистим canvas — иначе остаётся в DOM detached-элементом.
    canvas = null;
  }
  if (!gl) return null;
  // getExtension() может бросить на WebView с отключённым debug-info —
  // оборачиваем. UNMASKED_VENDOR_WEBGL/UNMASKED_RENDERER_WEBGL —
  // это официальные константы расширения, не 'unknown'.
  let vendor = 'unknown';
  let renderer = 'unknown';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      const v = gl.getParameter((dbg as unknown as { UNMASKED_VENDOR_WEBGL: number })
        .UNMASKED_VENDOR_WEBGL);
      const r = gl.getParameter((dbg as unknown as { UNMASKED_RENDERER_WEBGL: number })
        .UNMASKED_RENDERER_WEBGL);
      if (typeof v === 'string' && v) vendor = v;
      if (typeof r === 'string' && r) renderer = r;
    } else {
      // Без debug extension — попробуем обычные параметры (могут быть
      // "Google Inc. (NVIDIA)" вместо чистого имени, но лучше чем ничего).
      const v = gl.getParameter(gl.VENDOR);
      const r = gl.getParameter(gl.RENDERER);
      if (typeof v === 'string' && v) vendor = v;
      if (typeof r === 'string' && r) renderer = r;
    }
  } catch {
    // ignore
  }
  return { vendor, renderer };
}

/** Достаём screen size + DPI. На сервере / без window — 0/0/1. */
function detectScreen(): ScreenProbe {
  if (typeof screen === 'undefined') {
    return { width: 0, height: 0, dpi: 1 };
  }
  const w = Number(screen.width) || 0;
  const h = Number(screen.height) || 0;
  // devicePixelRatio — на window, не на navigator.
  const dpr =
    typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
      ? window.devicePixelRatio
      : 1;
  return { width: w, height: h, dpi: dpr };
}

/** Определяем ОС через userAgentData (Chromium 90+) либо fallback на
 *  navigator.platform (deprecated, но всё ещё работает в WebView2). */
function detectOs(): string {
  const nav = safeNav();
  if (!nav) return 'unknown';
  // userAgentData — новый API, замена navigator.platform. TS 5.6 не знает
  // про него (экспериментальный), читаем через any-каст.
  const uaData = (nav as unknown as { userAgentData?: { platform?: string } })
    .userAgentData;
  if (uaData?.platform) return uaData.platform;
  if (typeof nav.platform === 'string' && nav.platform) return nav.platform;
  if (typeof nav.userAgent === 'string') {
    // Последний fallback — парсим userAgent (Win64 / Mac / Linux).
    const ua = nav.userAgent;
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS X|macOS/i.test(ua)) return 'macOS';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iOS/i.test(ua)) return 'iOS';
    if (/Linux/i.test(ua)) return 'Linux';
  }
  return 'unknown';
}

/** CPU model: в web-API нет прямого способа получить brand. Пробуем
 *  navigator.userAgentData.getHighEntropyValues(['platform','uaFullVersion'])
 *  в promise — если поддерживается, вернёт что-то. Иначе 'unknown'. */
async function detectCpuModel(): Promise<string> {
  const nav = safeNav();
  if (!nav) return 'unknown';
  const uaData = (nav as unknown as {
    userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<Record<string, string>> };
  }).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const values = await uaData.getHighEntropyValues(['platform', 'uaFullVersion']);
      // uaFullVersion — это версия браузера, не CPU. Но в Chrome 105+ это
      // лучшее, что у нас есть. Для CPU model остаётся 'unknown'.
      if (typeof values?.platform === 'string' && values.platform) {
        return values.platform; // это не CPU, но хотя бы сигнал, что API живой
      }
    } catch {
      // ignore
    }
  }
  // User-Agent CPU detection — очень грубо, часто врёт. Не пытаемся.
  return 'unknown';
}

/** Async detector. Резолвится всегда, никогда не бросает. */
export async function detectHardware(): Promise<HardwareInfo> {
  const nav = safeNav();
  let cores: number | 'unknown' = 'unknown';
  let ram: number | 'unknown' = 'unknown';
  let language = 'unknown';
  if (nav) {
    // hardwareConcurrency — never undefined в современных браузерах, но TS не знает.
    const hc = (nav as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency;
    if (typeof hc === 'number' && hc > 0) cores = hc;
    // deviceMemory — экспериментальный, не во всех браузерах.
    const dm = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
    if (typeof dm === 'number' && dm > 0) ram = dm;
    if (typeof nav.language === 'string' && nav.language) language = nav.language;
  }
  const cpuModel = await detectCpuModel();
  return {
    cpu: { cores, model: cpuModel },
    ram,
    gpu: detectGpu(),
    os: detectOs(),
    disk: 'unknown',
    screen: detectScreen(),
    language,
  };
}
