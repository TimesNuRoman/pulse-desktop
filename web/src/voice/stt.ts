/**
 * Speech-to-Text — ЗАГЛУШКА-ИНТЕРФЕЙС.
 *
 * В следующих итерациях: Vosk (браузерный или WASM) или Whisper.cpp (через WASM-bindgen).
 *  - Vosk: быстрый, компактные модели (ru: vosk-model-small-ru-0.22), реально офлайн.
 *  - Whisper.cpp: точнее, но жирнее (1-3 ГБ ОЗУ на full); локально через wasm.
 *
 * Поток:
 *   1. start() — запросить микрофон, открыть стрим
 *   2. partial / final события
 *   3. final — отдать текст в чат как user-message
 */

export interface STTPartial {
  type: 'partial';
  /** промежуточный неполный текст */
  text: string;
  isFinal: false;
  ts: number;
}

export interface STTFinal {
  type: 'final';
  text: string;
  isFinal: true;
  ts: number;
}

/** STT-движок сигналит об ошибке через onResult (отдельный тип события). */
export interface STTErrorEvent {
  type: 'error';
  /** нормализованный код — UI может switch'ить по нему */
  code: 'not-allowed' | 'no-speech' | 'no-mic' | 'network' | 'aborted' | 'unknown';
  message: string;
  ts: number;
}

export type STTEvent = STTPartial | STTFinal | STTErrorEvent;

export type STTListener = (event: STTEvent) => void;

export interface STTEngine {
  /** начать слушать микрофон */
  start(): Promise<void>;
  /** остановить */
  stop(): Promise<void>;
  /** подписаться на события распознавания */
  onResult(listener: STTListener): () => void;
  /** какая модель сейчас активна */
  getModelId(): string | null;
}

/**
 * Заглушка: ничего не делает. start() кидает, чтобы UI не врал.
 */
export function createStubSTTEngine(): STTEngine {
  const listeners = new Set<STTListener>();
  return {
    async start() {
      // TODO(voice/stt): подключить Vosk или Whisper.cpp
      // - request mic permission
      // - load model (vosk-model-small-ru-0.22 / ggml-tiny.en.bin)
      // - start streaming recognition
      // - emit partial / final events
      throw new Error('stt engine not implemented yet — see web/src/voice/stt.ts');
    },
    async stop() {
      // noop
    },
    onResult(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getModelId() {
      return null;
    },
  };
}

export const STT_NOT_READY_MSG = 'STT не подключён. См. web/src/voice/stt.ts';
