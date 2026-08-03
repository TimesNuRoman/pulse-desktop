// SPDX-License-Identifier: Apache-2.0
// Pulse Agent v3.1 (R200) — streaming tool call parser.
//
// Pure lib, no UI / no Tauri / no fetch. Accumulates OpenAI-style
// `tool_calls` deltas from a chat-completions stream into complete
// `AssembledToolCall` objects. Defensive: NEVER throws. All parse
// anomalies are collected into `ParseResult.errors` for the UI.
//
// Why a separate module: R194's `runAgentLoop` is unmerged on a
// different branch (main 6b71e6c does NOT have it). R200 ships the
// parser as an independent lib so R201+ can wire it into the loop
// without conflict.
//
// Idempotency model:
//   - `id`: first non-empty wins, later ids with the same value are
//     no-ops, later ids with a DIFFERENT value produce an error
//     ("id collision" / "id conflict").
//   - `function.name` and `function.arguments`: APPEND (not replace).
//     LLMs can stream the same name twice if they retry mid-stream.
//   - Same delta added twice → name/args ARE appended again (id is
//     no-op). This is intentional: the parser is forward-only, and
//     double-add is a caller bug, not a parser bug. We do NOT throw.
//
// Multi-index: each ToolCallDelta has `index` (0, 1, 2, ...). We
// keep one partial per index in a Map. Gaps are allowed (no partial
// for skipped indexes). Indexes that exceed a sane cap are rejected
// (see MAX_INDEX below).
//
// NOT a substitute for argument parsing: `function.arguments` is the
// raw JSON STRING the LLM streamed. Caller (runAgentLoop in R201+)
// is responsible for `JSON.parse(args)`. We keep the string verbatim
// so the UI can show partial JSON during streaming if desired.
//
// Defensive checks (in order):
//   1. negative / non-integer / > MAX_INDEX index  → error, ignored
//   2. duplicate `id` at the same index            → no-op (idempotent)
//   3. conflicting `id` at the same index          → error
//   4. `id` already used at a DIFFERENT index      → error
//   5. delta for a call that was finalize()'d      → error ("already complete")
//
// Cyrillic / non-ASCII: passed through unchanged. We never escape,
// re-encode, or modify the streamed text. JavaScript `.length` is
// UTF-16 code units — fine for tracking deltas, callers can compute
// `.length` on the assembled `arguments` if they need a size budget.

/** Maximum `index` we'll accept. Anything beyond is treated as a bug. */
const MAX_INDEX = 1024;

/**
 * One streaming delta from a chat-completions stream.
 * Mirrors the OpenAI shape (`chunk.choices[0].delta.tool_calls[i]`).
 * Only `index` is required; everything else is optional and may be
 * absent on a given chunk.
 */
export interface ToolCallDelta {
  /** Position of this tool call in the array (0, 1, 2, ...). */
  index: number;
  /** Tool call id (e.g. "call_abc123"). Present on the first chunk only. */
  id?: string;
  /** OpenAI sets this to "function" on the first chunk. We accept any string. */
  type?: string;
  /** Function name + arguments, streamed in pieces. */
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * A fully-assembled tool call. `arguments` is the raw JSON string —
 * caller is responsible for `JSON.parse`. This is intentional: the
 * LLM may stream invalid JSON until the very last chunk.
 */
export interface AssembledToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

/** Anomalies collected during parsing. Surfaced to the UI, never thrown. */
export interface ParseError {
  index: number;
  message: string;
  raw: ToolCallDelta;
}

/** Result returned by `add()` / `addOne()` / `finalize()`. */
export interface ParseResult {
  /** Calls that have BOTH a non-empty `id` AND a non-empty `function.name`. */
  complete: AssembledToolCall[];
  /** Calls still waiting for more deltas (missing `id` or `function.name`). */
  pending: AssembledToolCall[];
  /** Anomalies collected this batch. */
  errors: ParseError[];
}

/**
 * Internal state for one in-progress tool call.
 * We track:
 *   - partial fields (id, type, name, arguments)
 *   - whether the parser has emitted this as "complete" (so we
 *     reject later deltas targeting the same index).
 */
interface PartialCall {
  id: string;
  idWasSet: boolean;
  type: string;
  name: string;
  arguments: string;
  finalized: boolean;
}

/**
 * Streaming accumulator for OpenAI-style tool_call deltas.
 *
 * Usage:
 *   const parser = new StreamingToolCallParser();
 *   for await (const chunk of stream) {
 *     const r = parser.add(chunk.choices[0].delta.tool_calls ?? []);
 *     if (r.complete.length) {
 *       // execute tool calls
 *     }
 *   }
 *   const final = parser.finalize(); // mark pending as complete
 *
 * State persists across `add()` calls. Call `reset()` to start over
 * (e.g. on stream error or cancellation).
 */
export class StreamingToolCallParser {
  /** partials[index] = in-progress call. Sparse (skipped indexes absent). */
  private partials: Map<number, PartialCall> = new Map();
  /** index where an id was first seen, for cross-index collision check. */
  private idOwner: Map<string, number> = new Map();
  /** Bump on reset() to invalidate any in-flight references. */
  private generation: number = 0;

  /** Add a batch of deltas. Returns the resulting state. */
  add(deltas: ToolCallDelta[]): ParseResult {
    if (!Array.isArray(deltas) || deltas.length === 0) {
      return this.snapshot();
    }
    for (const d of deltas) {
      this.absorb(d);
    }
    return this.snapshot();
  }

  /** Convenience for a single delta. Same semantics as `add([d])`. */
  addOne(delta: ToolCallDelta): ParseResult {
    return this.add([delta]);
  }

  /**
   * Mark all in-progress calls as "finalized" (the stream is done).
   * Best-effort: pending calls without an `id` get a synthesized id
   * like `__pending_0` so they can still be routed to the UI. Their
   * `arguments` may be malformed JSON — caller must handle parse
   * failures when it tries to `JSON.parse(args)`.
   */
  finalize(): ParseResult {
    for (const [index, partial] of this.partials) {
      if (partial.finalized) continue;
      if (!partial.idWasSet) {
        const synthId = '__pending_' + String(index);
        partial.id = synthId;
        partial.idWasSet = true;
        // Note: we do NOT add synth ids to idOwner — they're not
        // real LLM ids, so collision checks don't apply.
      }
      partial.finalized = true;
    }
    return this.snapshot();
  }

  /** Discard all state. Safe to call any time. */
  reset(): void {
    this.partials.clear();
    this.idOwner.clear();
    this.generation += 1;
  }

  /** All currently-tracked calls (complete + pending). */
  getAssembled(): AssembledToolCall[] {
    const out: AssembledToolCall[] = [];
    for (const [, partial] of this.partials) {
      out.push(this.toAssembled(partial));
    }
    return out;
  }

  /** Read-only count of in-progress calls. Cheap, for UI telemetry. */
  size(): number {
    return this.partials.size;
  }

  // ─── private ───────────────────────────────────────────────────────────

  /** Absorb one delta. All anomaly handling is in here. */
  private absorb(d: ToolCallDelta): void {
    // ── validate index ───────────────────────────────────────────────
    if (!Number.isInteger(d.index) || d.index < 0) {
      this.recordError(d.index, 'index must be a non-negative integer', d);
      return;
    }
    if (d.index > MAX_INDEX) {
      this.recordError(d.index, 'index exceeds cap (' + String(MAX_INDEX) + ')', d);
      return;
    }

    const existing = this.partials.get(d.index);

    // ── reject deltas for already-finalized calls ────────────────────
    if (existing && existing.finalized) {
      this.recordError(d.index, 'delta for already-finalized call', d);
      return;
    }

    // ── lazy-create partial ──────────────────────────────────────────
    const partial: PartialCall =
      existing ??
      {
        id: '',
        idWasSet: false,
        type: d.type ?? 'function',
        name: '',
        arguments: '',
        finalized: false,
      };

    // ── id handling: first non-empty wins, conflicts are errors ──────
    if (d.id !== undefined) {
      if (d.id === '') {
        // Empty id: treat as a no-op. Some proxies send "" on
        // non-first chunks to keep the field present.
      } else if (!partial.idWasSet) {
        // Cross-index collision check.
        const owner = this.idOwner.get(d.id);
        if (owner !== undefined && owner !== d.index) {
          this.recordError(d.index, 'id "' + d.id + '" already used at index ' + String(owner), d);
          return;
        }
        partial.id = d.id;
        partial.idWasSet = true;
        this.idOwner.set(d.id, d.index);
      } else if (partial.id !== d.id) {
        // Same index, conflicting id. Error but keep the FIRST id.
        this.recordError(d.index, 'id conflict (kept "' + partial.id + '", ignored "' + d.id + '")', d);
        return;
      }
      // partial.id === d.id → idempotent no-op.
    }

    // ── type handling: accept first non-empty value ──────────────────
    if (d.type !== undefined && d.type !== '' && partial.type === 'function' && d.type !== 'function') {
      // Only overwrite if we haven't been set yet. (We default to
      // "function" so we ignore subsequent "function" as no-op.)
      partial.type = d.type;
    }

    // ── function.name: append (LLMs can retry, don't lose data) ─────
    if (d.function?.name !== undefined && d.function.name !== '') {
      partial.name += d.function.name;
    }

    // ── function.arguments: append ───────────────────────────────────
    if (d.function?.arguments !== undefined && d.function.arguments !== '') {
      partial.arguments += d.function.arguments;
    }

    this.partials.set(d.index, partial);
  }

  /** Push a parse error into the last-absorbed delta's record. */
  private recordError(index: number, message: string, raw: ToolCallDelta): void {
    const err: ParseError = { index, message, raw };
    const target = this.partials.get(index);
    if (target) {
      // Attach to the partial so snapshot() includes it.
      const stash = (target as PartialCall & { _errors?: ParseError[] })._errors;
      if (stash) {
        stash.push(err);
      } else {
        (target as PartialCall & { _errors?: ParseError[] })._errors = [err];
      }
    } else {
      // No partial yet — store in a side-channel.
      const floaters = (this as unknown as { _floaters: ParseError[] })._floaters;
      if (floaters) {
        floaters.push(err);
      } else {
        (this as unknown as { _floaters: ParseError[] })._floaters = [err];
      }
    }
  }

  /** Collect _errors + _floaters into a single array (clears the stashes). */
  private drainErrors(): ParseError[] {
    const out: ParseError[] = [];
    const floaters = (this as unknown as { _floaters?: ParseError[] })._floaters;
    if (floaters && floaters.length > 0) {
      out.push(...floaters);
      (this as unknown as { _floaters: ParseError[] })._floaters = [];
    }
    for (const [, partial] of this.partials) {
      const stash = (partial as PartialCall & { _errors?: ParseError[] })._errors;
      if (stash && stash.length > 0) {
        out.push(...stash);
        (partial as PartialCall & { _errors?: ParseError[] })._errors = [];
      }
    }
    return out;
  }

  /** Build the public ParseResult from current state. */
  private snapshot(): ParseResult {
    const complete: AssembledToolCall[] = [];
    const pending: AssembledToolCall[] = [];
    for (const [, partial] of this.partials) {
      const a = this.toAssembled(partial);
      // "complete" = has BOTH a non-empty id AND a non-empty name.
      // finalize() status is orthogonal — the brief puts finalize() as
      // a hint, not a gate.
      if (partial.idWasSet && partial.name !== '') {
        complete.push(a);
      } else {
        pending.push(a);
      }
    }
    return { complete, pending, errors: this.drainErrors() };
  }

  /** Project a PartialCall to the public AssembledToolCall shape. */
  private toAssembled(p: PartialCall): AssembledToolCall {
    return {
      id: p.id,
      type: p.type,
      function: { name: p.name, arguments: p.arguments },
    };
  }
}
