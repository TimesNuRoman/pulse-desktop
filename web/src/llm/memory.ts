// SPDX-License-Identifier: Apache-2.0
// Pulse Agent v3.1 (R197) — conversation memory.
//
// Pure lib: управляет длиной диалога в пределах контекстного окна модели.
// Стратегии: жёсткий/мягкий token budget + sliding window + optional
// summarization через инжектируемый callback. Никакой I/O, никакого clock'а
// (тесты могут подсунуть `now: number` через объект config, если
// потребуется в будущем — на текущий момент unused, поле зарезервировано
// для совместимости с другими модулями agent v3.1).
//
// Использование (R198+ — UI-интеграция):
//   const mem = new ConversationMemory({ softTokenBudget: 6000, hardTokenBudget: 8000 });
//   mem.add({ role: 'system', content: SYSTEM_PROMPT });
//   for (const m of userTurns) mem.add(m);
//   if (needSummary) await mem.compact();     // async, дёргает summarizer
//   const ctx = mem.get();                    // для LLM-запроса
//   const stats = mem.getStats();             // для UI/debug
//
// Дизайн-решения задокументированы в R197-отчёте; ключевые:
//   - Системное сообщение и pinned индексы — никогда не дропаются.
//   - Последние `preserveRecentCount` сообщений — неявно pinned.
//   - `summarizer` — инжектируемый; throws caught (fallback: drop).
//   - `MemoryOverflowError` — только если summarizer не задан И hard
//     budget превышен И дропать нечего (защита от неконсистентного state'а).
//   - Sync API (`add`/`get`/`clear`/`setConfig`) не дёргает summarizer —
//     дропает без summary. Async `compact()` использует summarizer. Это
//     разделение позволяет UI делать add() без await'а, а summarize
//     дёргать explicit (например, раз в N сообщений или при user-pause).

import type { LLMMessage } from './types';

// ─── Config & types ───────────────────────────────────────────────────────

/** Стоимость одного image_url блока в токенах (OpenAI default). */
export const DEFAULT_IMAGE_TOKENS = 765;

export interface MemoryConfig {
  /** Soft target для токенов в диалоге (без system prompt). Default 6000. */
  softTokenBudget: number;
  /** Hard cap: за этим — дропаются самые старые сообщения. Default 8000. */
  hardTokenBudget: number;
  /** Сколько последних сообщений всегда сохранять (sliding window). Default 4. */
  preserveRecentCount: number;
  /** Token estimation: chars/4 (English), или override. Default 4. */
  charsPerToken: number;
  /** Стоимость одной картинки в токенах. Default 765 (OpenAI default). */
  imageTokens: number;
  /** Optional: при compact() вызывается для получения summary-строки. */
  summarizer?: (messages: LLMMessage[]) => Promise<string>;
}

export const DEFAULT_MEMORY_CONFIG: Omit<MemoryConfig, 'summarizer'> = {
  softTokenBudget: 6000,
  hardTokenBudget: 8000,
  preserveRecentCount: 4,
  charsPerToken: 4,
  imageTokens: DEFAULT_IMAGE_TOKENS,
};

export interface MemoryStats {
  totalMessages: number;
  estimatedTokens: number;
  droppedMessages: number;
  summarizedMessages: number;
  /** 0..1+ — доля hard budget. >1 означает overflow. */
  budgetUtilization: number;
}

// ─── Public: token estimation ─────────────────────────────────────────────

/** Считает примерное число токенов в одном сообщении. */
export function estimateMessageTokens(
  message: LLMMessage,
  charsPerToken: number,
  imageTokens: number,
): number {
  if (typeof message.content === 'string') {
    return Math.ceil(message.content.length / Math.max(1, charsPerToken));
  }
  // Multimodal: суммируем text + image
  let text = 0;
  let images = 0;
  for (const part of message.content) {
    if (part.type === 'text') {
      text += part.text.length;
    } else if (part.type === 'image_url') {
      images += 1;
    }
  }
  return Math.ceil(text / Math.max(1, charsPerToken)) + images * imageTokens;
}

/** Суммарные токены по массиву сообщений. */
export function estimateTokens(
  messages: LLMMessage[],
  charsPerToken: number = DEFAULT_MEMORY_CONFIG.charsPerToken,
  imageTokens: number = DEFAULT_MEMORY_CONFIG.imageTokens,
): number {
  if (messages.length === 0) return 0;
  let total = 0;
  for (const m of messages) {
    total += estimateMessageTokens(m, charsPerToken, imageTokens);
  }
  return total;
}

// ─── Public: errors ───────────────────────────────────────────────────────

/**
 * Бросается из sync `add()` (точнее из внутреннего `trimSync()`), когда
 * hard budget превышен И summarizer не настроен И дропать нечего
 * (всё pinned). С `summarizer` — не бросается: `compact()` справляется.
 * `code` стабилен для машинной обработки.
 */
export class MemoryOverflowError extends Error {
  readonly code = 'OVERFLOW' as const;
  readonly tokens: number;
  readonly budget: number;
  readonly pinnedCount: number;

  constructor(opts: { tokens: number; budget: number; pinnedCount: number }) {
    const msg =
      'Conversation overflow: ' +
      String(opts.tokens) +
      ' tokens > ' +
      String(opts.budget) +
      ' hard budget (' +
      String(opts.pinnedCount) +
      ' pinned, cannot drop).';
    super(msg);
    this.name = 'MemoryOverflowError';
    this.tokens = opts.tokens;
    this.budget = opts.budget;
    this.pinnedCount = opts.pinnedCount;
  }
}

// ─── Internal: entry shape ────────────────────────────────────────────────

interface InternalEntry {
  /** Индекс в оригинальном порядке add() — для pin-by-index. */
  originalIndex: number;
  message: LLMMessage;
  /** Computed pin (OR of manual + system + implicit-last-N). */
  pinned: boolean;
  /** Manual pin (задан через pinMessage/unpinMessage). */
  manualPin: boolean;
  /** Было ли это summary-сообщение, вставленное summarizer'ом. */
  isSummary: boolean;
}

// ─── Public: ConversationMemory ───────────────────────────────────────────

/**
 * Менеджер длины диалога. Mutates in-place при add(). `get()` возвращает
 * view текущего состояния; внутренний state — единственный источник
 * истины.
 *
 * Потокобезопасность: не потокобезопасен (sync API). Сейчас UI однопоточный,
 * позже можно обернуть в queue если понадобится.
 */
export class ConversationMemory {
  private entries: InternalEntry[] = [];
  private droppedCount = 0;
  private summarizedCount = 0;
  private config: MemoryConfig;
  /** Reserved for future timestamp tracking. */
  private readonly now: number;

  constructor(config: Partial<MemoryConfig> & { now?: number } = {}) {
    const { now = 0, ...rest } = config;
    this.now = now;
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...rest };
    this.sanitizeBudgets();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Добавить одно сообщение.
   *
   * Sync-поведение зависит от наличия summarizer:
   *  - Без summarizer: после append'а вызывает `trimSync()`, который
   *    дропает лишние сообщения (hard overflow / soft overflow). Кидает
   *    `MemoryOverflowError` если hard exceeded + нечего дропать (всё
   *    pinned).
   *  - С summarizer: НЕ дропает автоматически. Это позволяет накопить
   *    длинный диалог и потом явно вызвать `await compact()` для
   *    свёртки в summary (если auto-дропать, диалог «обрезается» прежде
   *    чем compact успеет что-то сделать). User is expected to call
   *    `compact()` periodically (например, на паузе между turn'ами).
   */
  add(message: LLMMessage): void {
    const originalIndex = this.entries.length;
    const isSystem = message.role === 'system';
    this.entries.push({
      originalIndex,
      message,
      pinned: isSystem, // computed (system → pinned)
      manualPin: isSystem, // system treated as manual
      isSummary: false,
    });
    if (!this.config.summarizer) {
      this.trimSync();
    }
  }

  /** Bulk-добавление. Один trim() в конце (если summarizer не задан). */
  addMany(messages: LLMMessage[]): void {
    for (const m of messages) {
      const originalIndex = this.entries.length;
      const isSystem = m.role === 'system';
      this.entries.push({
        originalIndex,
        message: m,
        pinned: isSystem,
        manualPin: isSystem,
        isSummary: false,
      });
    }
    if (!this.config.summarizer) {
      this.trimSync();
    }
  }

  /** Текущий видимый диалог (после trim/drop/summary). */
  get(): LLMMessage[] {
    return this.entries.map((e) => e.message);
  }

  /** Статистика — для observability/UI. */
  getStats(): MemoryStats {
    const tokens = this.estimateVisibleTokens();
    return {
      totalMessages: this.entries.length,
      estimatedTokens: tokens,
      droppedMessages: this.droppedCount,
      summarizedMessages: this.summarizedCount,
      budgetUtilization: this.config.hardTokenBudget
        ? tokens / this.config.hardTokenBudget
        : tokens > 0
          ? Infinity
          : 0,
    };
  }

  /** Полный сброс state. */
  clear(): void {
    this.entries = [];
    this.droppedCount = 0;
    this.summarizedCount = 0;
  }

  /** Runtime-update config (для UI-ползунков). Может потребовать trim(). */
  setConfig(config: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...config };
    this.sanitizeBudgets();
    this.trimSync();
  }

  /** Прочитать текущий config (для UI/debug). */
  getConfig(): Readonly<MemoryConfig> {
    return this.config;
  }

  /** Закрепить сообщение по originalIndex (никогда не дропается). */
  pinMessage(index: number): void {
    const entry = this.entries.find((e) => e.originalIndex === index);
    if (entry) {
      entry.manualPin = true;
      entry.pinned = true;
    }
  }

  /** Открепить сообщение по originalIndex. */
  unpinMessage(index: number): void {
    const entry = this.entries.find((e) => e.originalIndex === index);
    if (entry) {
      entry.manualPin = false;
      // Re-apply implicit pinning: pinned = manual || system || implicit
      this.applyImplicitPinning();
    }
  }

  /** Получить массив pinned originalIndex'ов (для UI). */
  getPinnedIndices(): number[] {
    return this.entries.filter((e) => e.pinned).map((e) => e.originalIndex);
  }

  /** Массив manual-pinned originalIndex'ов (исключая implicit+system). */
  getManualPinnedIndices(): number[] {
    return this.entries
      .filter((e) => e.manualPin)
      .map((e) => e.originalIndex);
  }

  /**
   * Async-свёртка: дёргает summarizer для самого старого не-pinned,
   * не-summary контига и заменяет его одним summary-сообщением.
   *
   * - Если summarizer не настроен: no-op (sync drop уже сделал работу).
   * - Если summarizer throws или вернул пустую строку: fallback — drop
   *   без replacement.
   * - Если есть pinned head (нечего сворачивать) и soft budget превышен:
   *   force-summarize all-but-first-system.
   *
   * Возвращает: число свёрнутых сообщений (>0 если что-то изменилось).
   */
  async compact(): Promise<number> {
    if (!this.config.summarizer) return 0;
    this.applyImplicitPinning();

    // Найти contiguous head не-pinned, не-summary сообщений.
    const head = this.findDroppableFromStart();
    if (head.length >= 1) {
      // Не делаем compact если head короче 2 — иначе теряем больше чем
      // экономим (summary длиннее исходного 1 сообщения).
      if (head.length >= 2) {
        return await this.summarizeDropped(head);
      }
      return 0;
    }

    // Head пуст (всё pinned/summary), но если всё ещё over soft —
    // пробуем force-режим.
    const tokens = this.estimateVisibleTokens();
    if (tokens > this.config.softTokenBudget) {
      return await this.forceSummarizeAllButSystem();
    }
    return 0;
  }

  // ─── Private: trim & summarize ──────────────────────────────────────────

  private sanitizeBudgets(): void {
    if (this.config.hardTokenBudget < this.config.softTokenBudget) {
      this.config.hardTokenBudget = this.config.softTokenBudget;
    }
    if (this.config.softTokenBudget < 0) this.config.softTokenBudget = 0;
    if (this.config.hardTokenBudget < 0) this.config.hardTokenBudget = 0;
  }

  private estimateVisibleTokens(): number {
    return estimateTokens(
      this.entries.map((e) => e.message),
      this.config.charsPerToken,
      this.config.imageTokens,
    );
  }

  /**
   * Sync-trim (вызывается из add/addMany). Дропает без summary.
   * Алгоритм:
   *  1) если под soft — no-op
   *  2) дропаем по одному, пока не уложимся в hard
   *  3) затем дропаем по одному, пока не уложимся в soft
   *  4) если дропать нечего (всё pinned) и hard всё ещё exceeded — throw
   *     (если summarizer — return; пусть compact разруливает)
   */
  private trimSync(): void {
    this.applyImplicitPinning();
    if (this.estimateVisibleTokens() <= this.config.softTokenBudget) return;

    // 2) Hard overflow path: drop until under hard.
    while (this.estimateVisibleTokens() > this.config.hardTokenBudget) {
      const dropped = this.dropOldestDroppable();
      if (!dropped) {
        // Nothing to drop.
        if (!this.config.summarizer) {
          throw new MemoryOverflowError({
            tokens: this.estimateVisibleTokens(),
            budget: this.config.hardTokenBudget,
            pinnedCount: this.entries.filter((e) => e.pinned).length,
          });
        }
        return; // summarizer will handle via compact()
      }
      this.applyImplicitPinning();
    }

    // 3) Soft path.
    while (this.estimateVisibleTokens() > this.config.softTokenBudget) {
      const dropped = this.dropOldestDroppable();
      if (!dropped) break;
      this.applyImplicitPinning();
    }
  }

  private applyImplicitPinning(): void {
    const n = this.config.preserveRecentCount;
    const start = Math.max(0, this.entries.length - n);
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e) continue;
      const isSystem = e.message.role === 'system';
      const isImplicit = i >= start;
      e.pinned = e.manualPin || isSystem || isImplicit;
    }
  }

  private findDroppableFromStart(): InternalEntry[] {
    const result: InternalEntry[] = [];
    for (const e of this.entries) {
      if (e.pinned) break;
      if (e.isSummary) break; // summary — «водораздел», не дропаем через него
      result.push(e);
    }
    return result;
  }

  private async summarizeDropped(dropped: InternalEntry[]): Promise<number> {
    if (!this.config.summarizer) return 0;
    const msgs = dropped.map((e) => e.message);
    let summaryText = '';
    try {
      summaryText = (await this.config.summarizer(msgs)).trim();
    } catch {
      // caught: fallback — drop без replacement.
      this.dropEntries(dropped);
      return dropped.length;
    }
    if (!summaryText) {
      this.dropEntries(dropped);
      return dropped.length;
    }
    const firstOriginal = dropped[0].originalIndex;
    const summaryContent = '[Earlier context: ' + summaryText + ']';
    const summaryEntry: InternalEntry = {
      originalIndex: firstOriginal,
      message: { role: 'system', content: summaryContent },
      pinned: false,
      manualPin: false,
      isSummary: true,
    };
    const dropIdxSet = new Set(dropped.map((e) => e.originalIndex));
    this.entries = this.entries.filter((e) => !dropIdxSet.has(e.originalIndex));
    const insertAt = this.entries.findIndex(
      (e) => e.originalIndex > firstOriginal,
    );
    const pos = insertAt === -1 ? this.entries.length : insertAt;
    this.entries.splice(pos, 0, summaryEntry);
    this.droppedCount += dropped.length;
    this.summarizedCount += 1;
    return dropped.length;
  }

  private async forceSummarizeAllButSystem(): Promise<number> {
    if (!this.config.summarizer) return 0;
    const nonSystem = this.entries.filter(
      (e) => e.message.role !== 'system',
    );
    if (nonSystem.length === 0) return 0;
    let summaryText = '';
    try {
      summaryText = (await this.config.summarizer(
        nonSystem.map((e) => e.message),
      )).trim();
    } catch {
      return 0;
    }
    if (!summaryText) return 0;
    const firstSystem = this.entries.find((e) => e.message.role === 'system');
    const summaryContent =
      '[Earlier context (compacted): ' + summaryText + ']';
    const summaryEntry: InternalEntry = {
      originalIndex: 0,
      message: {
        role: 'system',
        content: summaryContent,
      },
      pinned: false,
      manualPin: false,
      isSummary: true,
    };
    const firstSystemEntry: InternalEntry | null = firstSystem
      ? { ...firstSystem, pinned: true, manualPin: true, isSummary: false }
      : null;
    this.entries = firstSystemEntry
      ? [firstSystemEntry, summaryEntry]
      : [summaryEntry];
    this.droppedCount += nonSystem.length;
    this.summarizedCount += 1;
    return nonSystem.length;
  }

  private dropEntries(toDrop: InternalEntry[]): void {
    const dropIdxSet = new Set(toDrop.map((e) => e.originalIndex));
    this.entries = this.entries.filter((e) => !dropIdxSet.has(e.originalIndex));
    this.droppedCount += toDrop.length;
  }

  private dropOldestDroppable(): boolean {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.pinned) continue;
      if (e.isSummary) continue;
      this.entries.splice(i, 1);
      this.droppedCount += 1;
      return true;
    }
    return false;
  }
}
