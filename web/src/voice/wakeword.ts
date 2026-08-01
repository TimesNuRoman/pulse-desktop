/**
 * Wake word detection — ЗАГЛУШКА-ИНТЕРФЕЙС.
 *
 * В следующих итерациях: подключить Porcupine (Picovoice) или Vosk-KWS.
 *  - Porcupine: проприетарный, очень точный, бесплатен для личного использования,
 *    требует access key + .ppn файл с моделью.
 *  - Vosk-KWS: опенсорс, офлайн, можно встроить как часть Vosk STT.
 *
 * Поток:
 *   1. Захват микрофона (Web Audio API / MediaRecorder)
 *   2. Стрим в Porcupine / Vosk
 *   3. При срабатывании → эмитим событие "wake-word-detected" с keyword='pulse'
 *   4. UI вызывает startListening() из stt.ts
 */

export type WakeWord = 'pulse' | 'hey-pulse' | string;

export interface WakeWordEvent {
  keyword: WakeWord;
  /** уверенность 0..1, если движок даёт */
  confidence?: number;
  ts: number;
}

export type WakeWordListener = (event: WakeWordEvent) => void;

export interface WakeWordEngine {
  /** запустить движок, запросив доступ к микрофону */
  start(): Promise<void>;
  /** остановить и освободить ресурсы */
  stop(): Promise<void>;
  /** подписаться на срабатывания */
  onDetect(listener: WakeWordListener): () => void;
  /** сменить wake-word (если движок поддерживает) */
  setKeyword?(keyword: WakeWord): Promise<void>;
}

/**
 * Заглушка: при start() сразу бросает — "не реализовано".
 * Чтобы UI мог безопасно проверять `engine.isReady` и не падать.
 */
export function createStubWakeWordEngine(): WakeWordEngine {
  const listeners = new Set<WakeWordListener>();
  let running = false;
  return {
    async start() {
      // TODO(voice/wakeword): инициализировать Porcupine / Vosk-KWS
      // - request mic permission
      // - load model
      // - start processing loop
      throw new Error('wake word engine not implemented yet — see web/src/voice/wakeword.ts');
      running = true;
    },
    async stop() {
      running = false;
    },
    onDetect(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get isReady() {
      return false; // intentionally unimplemented stub
    },
  } as WakeWordEngine & { isReady: boolean };
}

export const WAKEWORD_NOT_READY_MSG =
  'Wake word не подключён. См. web/src/voice/wakeword.ts';
