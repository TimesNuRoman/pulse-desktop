# scripts/smart-engine-v3-real-eval/run-eval.ps1
#
# R79 — Smart Engine v3 real-user 100-prompt A/B harness.
#
# Цель: перепроверить результат R75 (+32pp pass rate, -1370ms p50) на
# РЕАЛЬНЫХ пользовательских промптах вместо 50 синтетических. R75
# использовал курированные v3Resp/baseResp (best-case test), R79
# использует 100 промптов в стиле реальных dev-запросов и оценивает
# (a) routing decision (Tier A) и (b) LLM response (Tier B, invoke mode).
#
# Режимы:
#   --simulate     Только routing-логика (зеркало engine в PS). Работает
#                  БЕЗ Pulse. Подходит для CI и для pre-R79 подготовки.
#   --invoke       Полный E2E: вызывает Pulse через IPC, захватывает
#                  ответ, скорит по рубрике. Требует R79-билд с
#                  IPC-командой `engine_decide` (НЕ существует в R78).
#                  Пока IPC нет — переходит в soft-fail с предупреждением.
#
# Примеры:
#   pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 -Mode simulate -Limit 5
#   pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 -Mode invoke -BuildPath "C:\Users\1\.minimax\workspace\downloads\Pulse-0.6.0-portable\Pulse.exe"
#   pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 -Mode simulate -EngineMode v3-on
#   pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 -Mode simulate -DryRun
#
# Engine modes (через -EngineMode baseline|v3-off|v3-on, default = v3-on):
#   baseline    — Smart Engine выключен, всё через default gemma3:4b
#   v3-off      — Smart Engine включён, но PassThreshold=99 (ни один flip не сработает)
#   v3-on       — Smart Engine включён с PassThreshold=8 (R79 default)

[CmdletBinding()]
param(
    [ValidateSet("simulate", "invoke")]
    [string]$Mode = "simulate",

    [ValidateSet("baseline", "v3-off", "v3-on")]
    [string]$EngineMode = "v3-on",

    [string]$BuildPath = "",
    [string]$PromptsPath = "",
    [string]$OutputDir = "",
    [int]$Limit = 0,
    [switch]$DryRun,
    [switch]$SkipCategorySummary
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# ── Paths ─────────────────────────────────────────────────────────────────

$ScriptDir = Split-Path -Parent $PSCommandPath
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$PromptsPath = if ($PromptsPath) { $PromptsPath } else { Join-Path $ScriptDir "prompts.jsonl" }
$OutputDir = if ($OutputDir) { $OutputDir } else { Join-Path $ProjectRoot "data" }
$RubricPath = Join-Path $ScriptDir "scoring-rubric.md"

if (-not (Test-Path $PromptsPath)) {
    Write-Error "Не нашёл prompts.jsonl: $PromptsPath"
    exit 1
}
if (-not (Test-Path $RubricPath)) {
    Write-Error "Не нашёл scoring-rubric.md: $RubricPath"
    exit 1
}
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Tag = "$Mode-$EngineMode"
$ResultFile = Join-Path $OutputDir "eval-results-$Tag-$Timestamp.jsonl"
$SummaryFile = Join-Path $OutputDir "eval-summary-$Tag-$Timestamp.json"

# ── Sanity: build path (только для invoke) ────────────────────────────────

if ($Mode -eq "invoke") {
    if (-not $BuildPath) {
        Write-Error "Режим invoke требует -BuildPath (например: C:\Users\1\.minimax\workspace\downloads\Pulse-0.6.0-portable\Pulse.exe)"
        exit 1
    }
    if (-not (Test-Path $BuildPath)) {
        Write-Error "BuildPath не найден: $BuildPath"
        exit 1
    }
    Write-Host "[harness] invoke mode target: $BuildPath" -ForegroundColor Cyan
} else {
    Write-Host "[harness] simulate mode (no Pulse required)" -ForegroundColor Cyan
}

# ── Загружаем промпты ─────────────────────────────────────────────────────
# Читаем построчно (JSONL — одна запись на строку), не -Raw.

$Prompts = @()
$lineNum = 0
Get-Content -Path $PromptsPath -Encoding UTF8 | ForEach-Object {
    $lineNum++
    $line = $_.Trim()
    if ($line) {
        try {
            $Prompts += ($line | ConvertFrom-Json)
        } catch {
            Write-Error "Невалидный JSON на строке $lineNum`: $_"
            throw
        }
    }
}

if ($Limit -gt 0 -and $Limit -lt $Prompts.Count) {
    Write-Host "[harness] limiting run to first $Limit prompts (out of $($Prompts.Count))" -ForegroundColor Yellow
    $Prompts = $Prompts[0..($Limit - 1)]
}

Write-Host "[harness] loaded $($Prompts.Count) prompts from $PromptsPath" -ForegroundColor Cyan

$byCategory = $Prompts | Group-Object category | ForEach-Object {
    [pscustomobject]@{ category = $_.Name; count = $_.Count }
}
Write-Host "[harness] category distribution:"
$byCategory | Format-Table | Out-String | Write-Host

# ── Smart Engine v3 logic (зеркало src-tauri/src/engine/smart_engine.rs) ─
#
# 4 conditions (порядок важен):
#   1) vision    — has_image=true → preferred="vision"
#   2) code-edit — has_code_markers=true → preferred="code" (если ещё default)
#   3) short     — 0 < chars < SHORT_CHARS AND NOT has_code_markers → "fast"
#   4) long      — chars > LONG_CHARS → "large" (если ещё default)
#
# Score: каждое условие = +5, category bonus = +2.
# PassThreshold: baseline=99, v3-off=99, v3-on=8 (R79 default).

$SHORT_CHARS = 60
$LONG_CHARS = 600
$CODE_MARKERS = @(
    "```rust", "```ts", "```tsx", "```js", "```py", "```go", "```rs",
    "fn ", "impl ", "trait ", "let mut ", "struct ", "enum ",
    "::new(", ".unwrap()", ".expect(", "pub fn", "async fn",
    "match ", "use serde", "use std::", "tauri::command", "tokio::",
    "println!", "dbg!", "-> Result<"
)
$TOOL_MARKERS = @(
    '{"name":', "tool_call", "function_call", "<tools>", "</tools>",
    "search_web(", "open_app(", "list_installed_apps(", "web_search(",
    "search_habr(", "search_files(", "read_text_file(", "cmd_show(",
    "cmd_hide(", "cmd_toggle(", "set_autostart(", "capture_screen(",
    "open_in_explorer(", "file_info(", "list_directory("
)

function Get-AutoPreferDecision {
    param(
        [string]$Text,
        [string]$Category,
        [int]$PassThreshold
    )
    $lower = $Text.ToLower()
    $hasCode = $false
    foreach ($m in $CODE_MARKERS) {
        if ($lower.Contains($m.ToLower())) { $hasCode = $true; break }
    }
    $hasTool = $false
    foreach ($m in $TOOL_MARKERS) {
        if ($lower.Contains($m.ToLower())) { $hasTool = $true; break }
    }
    $chars = ($Text | Measure-Object -Character).Characters

    $fired = New-Object System.Collections.Generic.List[string]
    $score = 0
    $preferred = "default"

    if ($hasCode) {
        $fired.Add("code-edit"); $score += 5
        if ($preferred -eq "default") { $preferred = "code" }
    }
    if ($chars -lt $SHORT_CHARS -and $chars -gt 0 -and -not $hasCode) {
        $fired.Add("short"); $score += 5
        if ($preferred -eq "default") { $preferred = "fast" }
    }
    if ($chars -gt $LONG_CHARS) {
        $fired.Add("long"); $score += 5
        if ($preferred -eq "default") { $preferred = "large" }
    }
    if ($Category) {
        $score += 2
    }
    if ($hasTool) {
        $fired.Add("tool-call-pattern")
        # tool-call-pattern НЕ добавляет score (зеркало Rust-логики, см. smart_engine.rs:221-224)
    }

    $flipped = ($score -ge $PassThreshold -and $preferred -ne "default")
    return [pscustomobject]@{
        preferred = $preferred
        fired = $fired.ToArray()
        score = $score
        flipped = $flipped
        chars = $chars
        has_code = $hasCode
        has_tool = $hasTool
    }
}

# PassThreshold по engine mode
$PassThreshold = switch ($EngineMode) {
    "baseline" { 99 }   # baseline не flip'ает, т.к. Smart Engine выключен
    "v3-off"    { 99 }   # v3-off = включён, но порог недостижим
    "v3-on"     { 8 }    # R79: relaxed PassThreshold 12 → 8
    default     { 8 }
}

# ── Tier A: routing scoring ──────────────────────────────────────────────
#
# Routing expectation table — какой preferred_model ожидаем для каждой
# категории. Это Tier A scoring rubric (см. scoring-rubric.md §A.1).

$ExpectedRouting = @{
    "habr-search"       = @("default", "large", "fast")   # default ok, large ok for long, fast ok for short
    "code-edit"         = @("code")                        # должен flip на code
    "quick-answer"      = @("default", "fast")             # default или fast
    "tool-call-pattern" = @("default", "fast")             # tool-call pattern не flip'ает
}

function Test-RoutingPass {
    param(
        [string]$Category,
        [string]$Preferred
    )
    $allowed = $ExpectedRouting[$Category]
    if ($null -eq $allowed) { return $false }
    return $allowed -contains $Preferred
}

# ── Tier B: response scoring (только invoke mode) ─────────────────────────
#
# Score = (response contains any expected_keyword) AND length in 30-1500.
# Простая keyword-эвристика, не LLM-judge. Roman-eyeball финальный.

function Test-ResponsePass {
    param(
        [string]$Response,
        [string[]]$Keywords
    )
    if ([string]::IsNullOrWhiteSpace($Response)) { return $false }
    if ($Response.Length -lt 30) { return $false }
    if ($Response.Length -gt 30000) { return $false }   # > 30K токенов — скорее всего мусор
    foreach ($k in $Keywords) {
        if ($Response -like "*$k*") { return $true }
    }
    return $false
}

# ── IPC invocation (только invoke mode) ──────────────────────────────────
#
# Эта функция — ЗАГЛУШКА. В R78 нет IPC-команды для `auto_prefer`, поэтому
# invoke-режим сейчас не может дёрнуть Pulse напрямую. Что нужно для
# полноценного invoke (см. §gap в scoring-rubric.md):
#
#   1. Coder agent добавляет в lib.rs:
#        #[tauri::command]
#        async fn engine_decide(user_text: String, category: Option<String>)
#            -> Result<EngineDecision, String> { ... }
#      + регистрация в generate_handler!
#
#   2. Coder agent добавляет в lib.rs:
#        #[tauri::command]
#        async fn engine_invoke(user_text: String, category: Option<String>,
#                               mode: String) -> Result<EngineInvokeResult, String>
#      mode = "baseline" | "v3-off" | "v3-on" → выбирает модель и
#      проксирует к Ollama (с реальным latency).
#
#   3. Запуск Pulse.exe и общение через WebSocket (Tauri IPC over WS) или
#      через sidecar (stdin/stdout JSON-RPC).
#
# Пока этого нет — invoke-mode логирует "IPC_NOT_AVAILABLE" и продолжает
# только с Tier A scoring (routing decision). Это by-design: harness
# работает уже сейчас, полный E2E ждёт R79 follow-up.

function Invoke-PulseEngine {
    param(
        [string]$Prompt,
        [string]$Category,
        [string]$EngineMode
    )
    # TODO R79: реализовать после добавления IPC-команд
    return [pscustomobject]@{
        available = $false
        response = $null
        latency_ms = 0
        error = "IPC_NOT_AVAILABLE: engine_decide/engine_invoke не реализованы в R78. Запусти -Mode simulate для Tier A scoring."
    }
}

# ── Прогон ───────────────────────────────────────────────────────────────

Write-Host "[harness] running A/B on $($Prompts.Count) prompts (mode=$Mode, engine=$EngineMode, threshold=$PassThreshold)..." -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[harness] DRY-RUN: первые 5 промптов, без записи на диск" -ForegroundColor Yellow
}

$results = New-Object System.Collections.Generic.List[object]
$conditionHits = [ordered]@{
    "vision" = 0; "code-edit" = 0; "short" = 0; "long" = 0; "tool-call-pattern" = 0
}
$routingPass = 0
$routingFail = 0
$responsePass = 0
$responseFail = 0
$ipcCallsAttempted = 0
$ipcCallsSucceeded = 0
$jsonlLines = New-Object System.Collections.Generic.List[string]
$progressCounter = 0
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

foreach ($p in $Prompts) {
    $progressCounter++
    Write-Progress -Activity "Smart Engine v3 real eval" -Status "$($p.id) [$($p.category)]" -PercentComplete (($progressCounter / $Prompts.Count) * 100)

    # Tier A: routing decision
    $decision = Get-AutoPreferDecision -Text $p.prompt -Category $p.category -PassThreshold $PassThreshold
    foreach ($f in $decision.fired) {
        if ($conditionHits.Contains($f)) { $conditionHits[$f]++ }
    }
    $tierA = Test-RoutingPass -Category $p.category -Preferred $decision.preferred
    if ($tierA) { $routingPass++ } else { $routingFail++ }

    # Tier B: response (только invoke mode)
    $response = $null
    $latency = 0
    $tierB = $null
    $tierBDetails = $null
    $ipcStatus = "n/a (simulate mode)"

    if ($Mode -eq "invoke") {
        $ipcCallsAttempted++
        $invokeResult = Invoke-PulseEngine -Prompt $p.prompt -Category $p.category -EngineMode $EngineMode
        $ipcStatus = if ($invokeResult.available) { "ok" } else { $invokeResult.error }
        if ($invokeResult.available) {
            $ipcCallsSucceeded++
            $response = $invokeResult.response
            $latency = $invokeResult.latency_ms
            $tierB = Test-ResponsePass -Response $response -Keywords $p.expected_keywords
            if ($tierB) { $responsePass++ } else { $responseFail++ }
        } else {
            $tierB = $false
        }
    }

    # Response excerpt
    $excerpt = $null
    if ($response) {
        $excerpt = ($response -replace "`r`n", " " -replace "`n", " ")
        if ($excerpt.Length -gt 200) { $excerpt = $excerpt.Substring(0, 200) }
    }

    # JSONL line
    $entry = [ordered]@{
        ts = $now
        prompt_id = $p.id
        category = $p.category
        engine_mode = $EngineMode
        eval_mode = $Mode
        prompt = $p.prompt
        response_excerpt = $excerpt
        latency_ms = [int]$latency
        routing = [ordered]@{
            preferred_model = $decision.preferred
            fired = @($decision.fired)
            score = $decision.score
            flipped = $decision.flipped
            pass_threshold = $PassThreshold
        }
        scoring = [ordered]@{
            tier_a_routing_pass = $tierA
            tier_b_response_pass = $tierB
            tier_b_quality = $null
            tier_b_correct = $null
            expected_mode = $p.expected_mode
            expected_keywords = $p.expected_keywords
        }
        ipc = $ipcStatus
    }
    $jsonlLines.Add(($entry | ConvertTo-Json -Compress -Depth 7))

    $results.Add([pscustomobject]@{
        id = $p.id
        category = $p.category
        preferred = $decision.preferred
        flipped = $decision.flipped
        score = $decision.score
        fired = ($decision.fired -join ",")
        tier_a = $tierA
        tier_b = $tierB
        latency = $latency
    })
}

Write-Progress -Activity "Smart Engine v3 real eval" -Completed

# ── Write JSONL (если не dry-run) ────────────────────────────────────────

if (-not $DryRun) {
    $jsonlLines | ForEach-Object {
        Add-Content -Path $ResultFile -Value $_ -Encoding UTF8
    }
    Write-Host "[harness] results: $ResultFile" -ForegroundColor DarkGray
}

# ── Summary ──────────────────────────────────────────────────────────────

$v3Latencies = @($results | Where-Object { $_.latency -gt 0 } | ForEach-Object { $_.latency } | Sort-Object)
function Get-Percentile {
    param([int[]]$Sorted, [double]$P)
    if ($Sorted.Count -eq 0) { return 0 }
    $idx = [int]([math]::Ceiling(($Sorted.Count - 1) * $P))
    if ($idx -ge $Sorted.Count) { $idx = $Sorted.Count - 1 }
    return $Sorted[$idx]
}
$p50 = Get-Percentile -Sorted $v3Latencies -P 0.50
$p95 = Get-Percentile -Sorted $v3Latencies -P 0.95

$byCat = $results | Group-Object category | ForEach-Object {
    $g = $_.Group
    [pscustomobject]@{
        category = $_.Name
        n = $g.Count
        routing_pass = (@($g | Where-Object tier_a)).Count
        response_pass = (@($g | Where-Object tier_b)).Count
        flipped_count = (@($g | Where-Object flipped)).Count
    }
}

$flippedCount = @($results | Where-Object { $_.flipped }).Count
$flippedRate = if ($results.Count -gt 0) { [math]::Round(($flippedCount / $results.Count) * 100, 1) } else { 0 }
$routingPassRate = if ($results.Count -gt 0) { [math]::Round(($routingPass / $results.Count) * 100, 1) } else { 0 }
$responsePassRate = if (($routingPass + $routingFail) -gt 0 -and $Mode -eq "invoke") {
    [math]::Round(($responsePass / ($responsePass + $responseFail)) * 100, 1)
} else { 0 }

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Magenta
Write-Host ("Mode:                {0}" -f $Mode)
Write-Host ("Engine mode:         {0} (PassThreshold={1})" -f $EngineMode, $PassThreshold)
Write-Host ("Total prompts:       {0}" -f $results.Count)
Write-Host ("Tier A pass:         {0}/{1} ({2}%)" -f $routingPass, $results.Count, $routingPassRate)
if ($Mode -eq "invoke") {
    Write-Host ("Tier B pass:         {0}/{1} ({2}%)" -f $responsePass, ($responsePass + $responseFail), $responsePassRate)
    Write-Host ("IPC calls OK:        {0}/{1}" -f $ipcCallsSucceeded, $ipcCallsAttempted)
} else {
    Write-Host "Tier B: skipped (simulate mode)" -ForegroundColor DarkGray
}
Write-Host ("Flipped:             {0}/{1} ({2}%)" -f $flippedCount, $results.Count, $flippedRate)
if ($v3Latencies.Count -gt 0) {
    Write-Host ("Latency p50/p95:     {0}ms / {1}ms" -f $p50, $p95)
}
Write-Host ""
Write-Host "=== Condition hit-rates ===" -ForegroundColor Magenta
foreach ($k in $conditionHits.Keys) {
    $rate = [math]::Round(($conditionHits[$k] / $results.Count) * 100, 1)
    Write-Host ("  {0,-20} {1}/{2} ({3}%)" -f $k, $conditionHits[$k], $results.Count, $rate)
}
Write-Host ""
Write-Host "=== By category ===" -ForegroundColor Magenta
$byCat | Format-Table -AutoSize | Out-String | Write-Host

# Recommendation
Write-Host "=== Routing recommendation ===" -ForegroundColor Magenta
if ($routingPassRate -ge 80) {
    Write-Host ("ROUTING OK: {0}% tier A pass — engine routing decisions are aligned with category expectations." -f $routingPassRate) -ForegroundColor Green
} elseif ($routingPassRate -ge 60) {
    Write-Host ("ROUTING MARGINAL: {0}% tier A pass — some categories may need marker-set expansion." -f $routingPassRate) -ForegroundColor Yellow
} else {
    Write-Host ("ROUTING REGRESSION: {0}% tier A pass — investigate marker set or threshold." -f $routingPassRate) -ForegroundColor Red
}

if ($flippedRate -ge 10 -and $EngineMode -eq "v3-on") {
    Write-Host ("THRESHOLD RELAXATION EFFECTIVE: {0}% flipped (target was 10-15%)." -f $flippedRate) -ForegroundColor Green
} elseif ($EngineMode -eq "v3-on") {
    Write-Host ("THRESHOLD RELAXATION INSUFFICIENT: only {0}% flipped, target 10-15%. Consider PassThreshold → 5." -f $flippedRate) -ForegroundColor Yellow
}

# Summary JSON
if (-not $DryRun) {
    $summary = [ordered]@{
        generated_at = (Get-Date -Format "o")
        mode = $Mode
        engine_mode = $EngineMode
        pass_threshold = $PassThreshold
        build_path = $BuildPath
        total_prompts = $results.Count
        tier_a_routing_pass = $routingPass
        tier_a_routing_fail = $routingFail
        tier_a_routing_pass_rate = $routingPassRate
        tier_b_response_pass = $responsePass
        tier_b_response_fail = $responseFail
        tier_b_response_pass_rate = $responsePassRate
        flipped_count = $flippedCount
        flipped_rate_pct = $flippedRate
        latency_p50_ms = $p50
        latency_p95_ms = $p95
        condition_hits = $conditionHits
        by_category = $byCat
        ipc_calls_attempted = $ipcCallsAttempted
        ipc_calls_succeeded = $ipcCallsSucceeded
        result_file = $ResultFile
    }
    $summary | ConvertTo-Json -Depth 5 | Set-Content -Path $SummaryFile -Encoding UTF8
    Write-Host "[harness] summary: $SummaryFile" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "[harness] done" -ForegroundColor Green
exit 0
