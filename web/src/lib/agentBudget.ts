// SPDX-License-Identifier: Apache-2.0
//
// Agent v3.1 — budget tracker (tool calls / turns / tokens).
//
// Бюджет защищает от runaway-циклов: если модель упорно просит tool_calls
// и не возвращает финальный текст, через 8 попыток / 15 ходов / 32K
// токенов — выкидываем `BudgetExceededError` и `runAgentLoop` перестаёт
// повторять. Без бюджета один баг в парсере tool_calls мог бы зациклить
// LLM навсегда (Ollama бы отдавал всё новые tool_use, и счёт за токены
// рос бы линейно).
//
// Все счётчики чистые, без побочных эффектов. Бюджет не знает про
// LLM/stream — он просто инкрементирует числа и кидает при превышении.

/** Коды причин превышения бюджета. */
export type BudgetExceededCode = 'TOOL_CALLS' | 'TURNS' | 'TOKENS';

export interface AgentBudgetOpts {
  /** Макс. кол-во вызовов инструментов за один loop. По умолчанию 8. */
  maxToolCalls?: number;
  /** Макс. кол-во ходов (model→tool→model→tool → ...). По умолчанию 15. */
  maxTurns?: number;
  /** Макс. токенов за один loop. По умолчанию 32000. */
  maxTokens?: number;
}

export interface BudgetSnapshot {
  toolCalls: number;
  turns: number;
  tokens: number;
  /** Всегда false на snapshot — exceeded живёт только в момент throw. */
  exceeded: false;
}

/** Дефолтные лимиты. gemma3:4b + tools типично укладывается в 4-6 ходов. */
export const DEFAULT_BUDGET_LIMITS: Required<AgentBudgetOpts> = {
  maxToolCalls: 8,
  maxTurns: 15,
  maxTokens: 32000,
};

/**
 * Кинется при превышении любого из лимитов. `code` указывает, какой
 * именно счётчик сработал; `limit` — текущее значение лимита (для
 * telemetry и UI). `actual` — сколько насчитали к моменту throw.
 */
export class BudgetExceededError extends Error {
  readonly code: BudgetExceededCode;
  readonly limit: number;
  readonly actual: number;

  constructor(code: BudgetExceededCode, limit: number, actual: number) {
    super(`Budget exceeded (${code}): ${actual} >= ${limit}`);
    this.name = 'BudgetExceededError';
    this.code = code;
    this.limit = limit;
    this.actual = actual;
    // Сохраняем stack trace (особенность V8 для ES5-классов).
    if (typeof (Error as any).captureStackTrace === 'function') {
      (Error as any).captureStackTrace(this, BudgetExceededError);
    }
  }
}

/**
 * Счётчик бюджета. Хранит tool calls / turns / tokens, кидает
 * `BudgetExceededError` при превышении лимитов. Потокобезопасен на
 * уровне JS-однопоточности (доп. синхронизация не нужна).
 */
export class AgentBudget {
  private readonly maxToolCalls: number;
  private readonly maxTurns: number;
  private readonly maxTokens: number;

  private _toolCalls = 0;
  private _turns = 0;
  private _tokens = 0;

  constructor(opts: AgentBudgetOpts = {}) {
    this.maxToolCalls = opts.maxToolCalls ?? DEFAULT_BUDGET_LIMITS.maxToolCalls;
    this.maxTurns = opts.maxTurns ?? DEFAULT_BUDGET_LIMITS.maxTurns;
    this.maxTokens = opts.maxTokens ?? DEFAULT_BUDGET_LIMITS.maxTokens;
  }

  /** Зарегистрировать вызов инструмента. Кидает BudgetExceededError. */
  recordToolCall(): void {
    this._toolCalls += 1;
    if (this._toolCalls > this.maxToolCalls) {
      throw new BudgetExceededError('TOOL_CALLS', this.maxToolCalls, this._toolCalls);
    }
  }

  /** Зарегистрировать завершённый ход (model→tool или model→text). Кидает. */
  recordTurn(): void {
    this._turns += 1;
    if (this._turns > this.maxTurns) {
      throw new BudgetExceededError('TURNS', this.maxTurns, this._turns);
    }
  }

  /** Зарегистрировать N токенов (из usage-поля ответа). Не кидает. */
  recordTokens(n: number): void {
    if (!Number.isFinite(n) || n < 0) return;
    this._tokens += Math.floor(n);
    if (this._tokens > this.maxTokens) {
      throw new BudgetExceededError('TOKENS', this.maxTokens, this._tokens);
    }
  }

  /** Текущее состояние всех счётчиков. `exceeded` всегда false (см. тип). */
  snapshot(): BudgetSnapshot {
    return {
      toolCalls: this._toolCalls,
      turns: this._turns,
      tokens: this._tokens,
      exceeded: false,
    };
  }

  /** Геттеры — удобно для тестов и UI. */
  get toolCalls(): number { return this._toolCalls; }
  get turns(): number { return this._turns; }
  get tokens(): number { return this._tokens; }
  get limits(): Readonly<Required<AgentBudgetOpts>> {
    return {
      maxToolCalls: this.maxToolCalls,
      maxTurns: this.maxTurns,
      maxTokens: this.maxTokens,
    };
  }
}
