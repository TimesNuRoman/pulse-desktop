// SPDX-License-Identifier: Apache-2.0
//
// Agent v3.1 — in-memory telemetry store.
//
// Чистый in-memory сборщик метрик для agent loop'а. Не пишет в сеть, не
// пишет в localStorage, не зависит от Tauri — просто хранит последние
// события в кольцевом буфере и считает counter'ы/latency'ы. UI может
// подписаться через `subscribe()` и получать snapshot после каждого
// `recordEvent`/`recordError`/... — пригодится для будущего devtools
// окошка «почему agent зациклился».
//
// Все методы детерминированные (кроме внутренних timestamp'ов из
// `performance.now()` если бы они были — но мы их намеренно не храним,
// чтобы snapshot был стабильным в тестах).

export interface TelemetryEvent {
  /** Unix-time в мс. Используем Date.now() — проще тестировать. */
  ts: number;
  /** Имя события, например "llm.attempt" или "tool.start". */
  name: string;
  /** Доп. атрибуты (только примитивы: string/number). */
  attrs?: Record<string, string | number>;
}

export interface LatencyStat {
  count: number;
  min: number;
  max: number;
  /** Скользящее среднее (running average). */
  avg: number;
  sum: number;
}

export interface RecordedError {
  name: string;
  message: string;
  ts: number;
}

export interface TelemetrySnapshot {
  /** Все counter'ы: имя → значение. */
  counters: Record<string, number>;
  /** Все latency-имена → статистика. */
  latencies: Record<string, LatencyStat>;
  /** Все зафиксированные ошибки. */
  errors: RecordedError[];
  /** Последние N событий (FIFO из кольцевого буфера). */
  recentEvents: TelemetryEvent[];
  /** Кол-во событий всего с момента последнего reset. */
  totalEvents: number;
}

/** Кол-во событий в кольцевом буфере. Хватает для дебага одной сессии. */
export const DEFAULT_RING_BUFFER_SIZE = 100;

/** Подписчик: вызывается после каждого record*. Возвращает unsubscribe. */
export type TelemetryListener = (snap: TelemetrySnapshot) => void;

/**
 * Telemetry store. Создаётся на старте loop'а (или инжектится извне
 * для агрегации между loop'ами). Все методы чистые, no I/O.
 */
export class AgentTelemetry {
  private readonly ringSize: number;
  private counters: Map<string, number> = new Map();
  private latencies: Map<string, LatencyStat> = new Map();
  private errors: RecordedError[] = [];
  private ring: TelemetryEvent[] = [];
  private totalEvents = 0;
  private listeners: Set<TelemetryListener> = new Set();

  constructor(ringSize: number = DEFAULT_RING_BUFFER_SIZE) {
    if (ringSize < 1) throw new Error('ringSize must be >= 1');
    this.ringSize = ringSize;
  }

  /**
   * Записать произвольное событие. Атрибуты — примитивы (string/number),
   * иначе snapshot становится несериализуемым. Большие/цикличные объекты
   * лучше сразу стрингифицировать в attrs.
   */
  recordEvent(name: string, attrs?: Record<string, string | number>): void {
    const ev: TelemetryEvent = {
      ts: Date.now(),
      name,
      attrs: attrs ? { ...attrs } : undefined,
    };
    this.pushEvent(ev);
    this.totalEvents += 1;
    this.notify();
  }

  /**
   * Записать ошибку: складываем в отдельный массив (не в ring) и в
   * counter `errors.{name}` для агрегации. `name` и `message` берём из
   * err, fallback — на err.name/message или "Error" / String(err).
   */
  recordError(name: string, err: unknown): void {
    const e = err instanceof Error
      ? { name: err.name, message: err.message }
      : { name: 'Error', message: String(err) };
    this.errors.push({ ...e, ts: Date.now() });
    // Не вызываем incrementCounter здесь — он делает свой notify,
    // а мы хотим ровно один notify на recordError.
    this.counters.set(`errors.${name}`, (this.counters.get(`errors.${name}`) ?? 0) + 1);
    this.totalEvents += 1;
    this.notify();
  }

  /**
   * Записать latency-семпл. Обновляет min/max/avg/count/sum для имени.
   * Невалидные значения (NaN / отрицательные / не-числа) игнорируем —
   * telemetry не должна ломать основной flow.
   */
  recordLatency(name: string, ms: number): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    const cur = this.latencies.get(name);
    if (!cur) {
      this.latencies.set(name, { count: 1, min: ms, max: ms, sum: ms, avg: ms });
    } else {
      const count = cur.count + 1;
      const sum = cur.sum + ms;
      this.latencies.set(name, {
        count,
        min: Math.min(cur.min, ms),
        max: Math.max(cur.max, ms),
        sum,
        avg: sum / count,
      });
    }
    this.totalEvents += 1;
    this.notify();
  }

  /**
   * Увеличить counter на `by` (default 1). Если counter ещё не
   * существует — создаёт с начальным значением. Отрицательные значения
   * допустимы (можно «откатывать»).
   */
  incrementCounter(name: string, by: number = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
    this.totalEvents += 1;
    this.notify();
  }

  /**
   * Полный snapshot для передачи в результат loop'а или подписчикам.
   * Возвращаем копии внутренних структур (snapshot immutability).
   */
  snapshot(): TelemetrySnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      latencies: Object.fromEntries(
        [...this.latencies.entries()].map(([k, v]) => [k, { ...v }]),
      ),
      errors: this.errors.map((e) => ({ ...e })),
      recentEvents: this.ring.map((e) => ({ ...e, attrs: e.attrs ? { ...e.attrs } : undefined })),
      totalEvents: this.totalEvents,
    };
  }

  /**
   * Подписаться на изменения. Listener вызывается ПОСЛЕ каждого record*
   * (синхронно, не через queueMicrotask). Возвращает функцию отписки.
   *
   * ВАЖНО: listener'ы не должны бросать — мы не ловим, и throw убьёт
   * основной flow. Если нужно логировать ошибки подписчика — оборачивайте
   * в try/catch внутри listener'а.
   */
  subscribe(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Кол-во подписчиков (для тестов). */
  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** Сбросить всё в ноль. */
  reset(): void {
    this.counters.clear();
    this.latencies.clear();
    this.errors = [];
    this.ring = [];
    this.totalEvents = 0;
    this.notify();
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private pushEvent(ev: TelemetryEvent): void {
    this.ring.push(ev);
    if (this.ring.length > this.ringSize) {
      this.ring.shift();
    }
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        // Listener-ы не должны бросать. Игнорируем.
      }
    }
  }
}
