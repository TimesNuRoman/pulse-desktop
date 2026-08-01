/**
 * Screen capture + OCR — ЗАГЛУШКА-ИНТЕРФЕЙС.
 *
 * В следующих итерациях:
 *  - Скриншот: Tauri-команда `capture_screen` (см. бывший вариант в src-tauri/src/lib.rs)
 *    или `window.screenshot()` через tauri::WebviewWindow (если добавим в Rust).
 *  - OCR:
 *      • Tesseract.js (wasm) — простой, средняя точность, офлайн.
 *      • Vision API (Google / OpenAI) — точнее, но требует ключа.
 *      • PaddleOCR (wasm/native) — лучший опенсорс-выбор для кириллицы.
 *
 * Поток:
 *   1. captureScreen() → PNG-байты (или base64)
 *   2. ocrImage(png) → { text, blocks: [{text, bbox}] }
 *   3. Кладём текст в чат как user-message (или как контекст для LLM).
 */

export interface ScreenCapture {
  /** PNG в base64 (data URL без префикса) */
  base64: string;
  /** ширина/высота картинки */
  width: number;
  height: number;
  ts: number;
}

export interface OCRBlock {
  text: string;
  /** опционально: bbox в пикселях исходного изображения */
  bbox?: { x: number; y: number; w: number; h: number };
  /** уверенность 0..1 */
  confidence?: number;
}

export interface OCRResult {
  text: string;
  blocks: OCRBlock[];
  language: string;
  ts: number;
}

export interface ScreenOCREngine {
  /** снять скриншот основного монитора */
  captureScreen(): Promise<ScreenCapture>;
  /** распознать текст на PNG (base64) */
  ocrImage(base64: string, lang?: string): Promise<OCRResult>;
  /** скриншот + OCR одной функцией */
  captureAndRead(lang?: string): Promise<OCRResult & { screen: ScreenCapture }>;
}

/**
 * Заглушка. captureScreen() / ocrImage() кидают — UI не должен их звать
 * до явной реализации.
 */
export function createStubScreenOCREngine(): ScreenOCREngine {
  return {
    async captureScreen() {
      // TODO(screen/ocr): вернуть снимок через Tauri-команду
      // вариант 1: нативный скриншот (screenshots crate) на стороне Rust
      // вариант 2: html2canvas + canvas.toDataURL() (только webview, без всего экрана)
      throw new Error('screen capture not implemented — see web/src/screen/ocr.ts');
    },
    async ocrImage(_base64: string, _lang?: string) {
      // TODO(screen/ocr): подключить Tesseract.js / PaddleOCR / vision API
      throw new Error('OCR not implemented — see web/src/screen/ocr.ts');
    },
    async captureAndRead(_lang?: string) {
      throw new Error('screen capture + OCR not implemented — see web/src/screen/ocr.ts');
    },
  };
}

export const SCREEN_OCR_NOT_READY_MSG = 'OCR/screen capture не подключён. См. web/src/screen/ocr.ts';
