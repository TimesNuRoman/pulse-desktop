/**
 * Speech-to-Text через Web Speech API (window.SpeechRecognition / webkitSpeechRecognition).
 *
 * Работает в Tauri v2 WebView2 на Windows (Edge-based WebView2 поддерживает
 * webkitSpeechRecognition и проксирует в облачный Microsoft Online Speech Service —
 * нужен интернет). Если API нет в окне — фабрика getSTTEngine() подменит на stub.
 *
 * Режим: single-shot. continuous=false, interimResults=true.
 *   - partial (isFinal=false) — обновляем «живой» текст в UI по мере речи
 *   - final   (isFinal=true)  — фиксируем в буфер
 *   - onend                 — отдаём накопленный final как STTFinal
 *
 * Ошибки (через STTErrorEvent):
 *   - 'not-allowed'  — браузер не дал доступ к микрофону
 *   - 'no-speech'    — пользователь ничего не сказал (тихая отмена, без UI)
 *   - 'no-mic'       — нет микрофона
 *   - 'network'      — нет сети / сервис недоступен
 *   - 'aborted'      — start() не успел / повторный start
 *   - 'unknown'      — прочее
 */

import type { STTEngine, STTErrorEvent, STTEvent, STTListener } from './stt';

type AnyRecognition = any; // SpeechRecognition / webkitSpeechRecognition — в lib.dom.d.ts нет стабильного типа

function getSpeechRecognitionCtor(): AnyRecognition | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: AnyRecognition;
    webkitSpeechRecognition?: AnyRecognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function normalizeError(event: any): STTErrorEvent['code'] {
  // event.error — строка от Web Speech API
  // https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionErrorEvent/error
  switch (event?.error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'no-speech':
      return 'no-speech';
    case 'audio-capture':
      return 'no-mic';
    case 'network':
      return 'network';
    case 'aborted':
      return 'aborted';
    default:
      return 'unknown';
  }
}

export interface WebSpeechSTTOptions {
  /** BCP-47 language tag, по умолчанию 'ru-RU' */
  lang?: string;
  /** continuous=true — слушать до явного stop(). По умолчанию false (single-shot). */
  continuous?: boolean;
}

export function createWebSpeechSTTEngine(options: WebSpeechSTTOptions = {}): STTEngine {
  const lang = options.lang ?? 'ru-RU';
  const continuous = options.continuous ?? false;

  const listeners = new Set<STTListener>();
  const emit = (e: STTEvent) => listeners.forEach((l) => l(e));

  // mutable state — каждый start() создаёт новый recognition, не переиспользуем
  let recognition: AnyRecognition | null = null;
  let running = false;
  let finalBuf = ''; // накопленные финальные фразы за текущую сессию

  function newRecognition(): AnyRecognition {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) throw new Error('Web Speech API недоступен в этом окружении');
    const r = new Ctor();
    r.lang = lang;
    r.continuous = continuous;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
      running = true;
      finalBuf = '';
    };

    r.onresult = (event: any) => {
      // event.results — SpeechRecognitionResultList, по каждой фразе
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript: string = res[0]?.transcript ?? '';
        if (res.isFinal) {
          finalBuf += transcript + ' ';
        } else {
          interim += transcript;
        }
      }
      const now = Date.now();
      // Отдаём «что есть прямо сейчас»: финальный буфер + interim.
      // UI использует это для live-превью.
      if (interim) {
        emit({ type: 'partial', text: (finalBuf + interim).trim(), isFinal: false, ts: now });
      }
    };

    r.onerror = (event: any) => {
      const code = normalizeError(event);
      // no-speech — тихая отмена, событие всё равно эмитим, но UI решит не паниковать
      emit({ type: 'error', code, message: String(event?.message ?? event?.error ?? 'stt error'), ts: Date.now() });
    };

    r.onend = () => {
      // Если есть что-то в finalBuf — отдадим финальным событием
      if (finalBuf.trim()) {
        emit({ type: 'final', text: finalBuf.trim(), isFinal: true, ts: Date.now() });
      }
      running = false;
      recognition = null;
    };

    return r;
  }

  return {
    async start() {
      if (running) {
        // уже идёт — повторный start считаем no-op
        return;
      }
      finalBuf = '';
      recognition = newRecognition();
      try {
        // recognition.start() — может кинуть InvalidStateError, либо браузер сам
        // спросит permission (промпт) на микрофон. Если запретят — придёт onerror('not-allowed').
        recognition.start();
      } catch (e) {
        running = false;
        recognition = null;
        emit({
          type: 'error',
          code: 'aborted',
          message: (e as Error)?.message ?? 'failed to start recognition',
          ts: Date.now(),
        });
        throw e;
      }
    },

    async stop() {
      if (!recognition) return;
      try {
        recognition.stop(); // триггернёт onresult (если есть что финализировать) + onend
      } catch {
        // ignore — onend всё равно сработает
      }
    },

    onResult(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getModelId() {
      // Web Speech API не раскрывает модель; возвращаем осмысленный идентификатор
      return `webspeech:${lang}`;
    },
  };
}
