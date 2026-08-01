// Smoke test for shouldWebSearch heuristic.
// Run: `node scripts/test-should-web-search.mjs`
// No test infra required — outputs OK/FAIL per case and exits 1 on any failure.
//
// Cases cover false positives that were a problem with the previous regex:
//   - "Привет, у меня новый ноут" should NOT trigger
//   - "Какая погода в Бресте" should NOT trigger
//   - "Объясни что такое SVE" should NOT trigger
//   - "2024" alone should NOT trigger
// and true positives:
//   - "What is the new GPT-4 model version?" should trigger (new + version)
//   - "Привет, последние новости" should trigger (последние + новости)
//   - "Документация по Tauri v2" should trigger (документация)
//   - "2024 год" should trigger (2024 + word after)
//   - "new update for the system" should trigger (new + update)

const cases = [
  // False positives that the old regex caught (and we should NOT):
  ["Привет, у меня новый ноут", false, "old regex matched 'новый' alone"],
  ["Какая погода в Бресте", false, "no markers"],
  ["Объясни что такое SVE", false, "factual but no temporal marker"],
  ["2024 — какой год", false, "20YY in middle of sentence needs word after"],
  ["Привет, как дела?", false, "no markers"],
  ["Расскажи про Docker", false, "no markers"],
  ["новый", false, "'новый' alone is not a search trigger"],
  // True positives:
  ["Что нового в Rust 2024?", true, "what's new + 2024"],
  ["Документация по Tauri v2", true, "документация"],
  ["latest Docker release", true, "latest + release"],
  ["Show me release notes", true, "release notes"],
  ["What is the new GPT-4 model version?", true, "new + version"],
  ["Привет, последние новости", true, "последние + новости"],
  ["2024 год", true, "2024 + cyrillic word after"],
  ["Today is a good day", true, "today"],
  ["Привет, как дела?", false, "no markers"],
  ["Что нового в мире", true, "что нового"],
  ["new update for the system", true, "new + update"],
  ["Release notes for v2", true, "release"],
  ["актуальные новости", true, "актуальные + новости"],
  ["документация по API", true, "документация"],
  ["новый релиз", true, "релиз alone is a strong signal"],
  ["новый релиз модели", true, "релиз + модель"],
];

// Import the function under test.
// tools.ts is TypeScript, so we need to handle that. Two options:
//   1) Compile tools.ts with tsc first, then import
//   2) Inline-port the regex logic here
// For test portability, option 2 — but that duplicates code. For now, we
// load via a tiny shim that strips TS-specific bits and evals.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const toolsPath = resolve(here, '..', 'web', 'src', 'llm', 'tools.ts');
const toolsSrc = readFileSync(toolsPath, 'utf8');

// Extract just the shouldWebSearch function (TS → JS via tiny strip).
// We only need the function body and the regex; types are erased.
const fnMatch = toolsSrc.match(
  /export function shouldWebSearch\(text: string\): boolean \{[\s\S]*?\n\}/,
);
if (!fnMatch) {
  console.error('FAIL: could not extract shouldWebSearch from', toolsPath);
  process.exit(2);
}
const fnSrc = fnMatch[0]
  .replace(/: string/g, '')
  .replace(/: boolean/g, '')
  .replace(/export /, '');

// eslint-disable-next-line no-eval
const shouldWebSearch = eval(`(function() { ${fnSrc}; return shouldWebSearch; })()`);

let pass = 0;
let fail = 0;
for (const [input, expected, comment] of cases) {
  const got = shouldWebSearch(input);
  const ok = got === expected;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} expected=${expected} got=${got} :: "${input}" — ${comment}`,
  );
  if (ok) pass++;
  else fail++;
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
