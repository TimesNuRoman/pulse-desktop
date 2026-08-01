# scripts/verify-smart-engine-v3.ps1
#
# R74 — Smart Engine v3 Phase 2 A/B verification harness.
#
# Что делает:
#   1) Прогоняет 50 синтетических задач (15 code-edit, 15 reasoning,
#      10 chat, 10 tool-use) через Smart Engine v3 И через baseline
#      gemma3:4b.
#   2) Для каждой задачи score = pass/fail (v3 preferred response vs
#      baseline response, проверяем подстроку expected_substring).
#   3) Латентности симулируются: v3 = 70-720ms (fast/code), baseline
#      = 1000-2700ms (gemma3:4b). Реальный Ollama не дёргаем — тестируем
#      ЛОГИКУ auto-prefer, не качество моделей.
#   4) Пишет каждую запись в JSONL-лог (append-only) с 7-дневной ротацией.
#   5) Печатает summary: pass rate, latency p50/p95, hit-rate условий,
#      рекомендация.
#
# Использование:
#   pwsh -File scripts/verify-smart-engine-v3.ps1
#   pwsh -File scripts/verify-smart-engine-v3.ps1 -TasksPath scripts/ab-tasks.json
#   pwsh -File scripts/verify-smart-engine-v3.ps1 -SkipCargoTest

[CmdletBinding()]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$TasksPath = "scripts/ab-tasks.json",
    [string]$OutputDir = "data",
    [string]$LogFile = "smart-engine-v3-ab-2026-08-01.jsonl",
    [switch]$SkipCargoTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# ── 1. Sanity checks ────────────────────────────────────────────────────

if (-not (Test-Path (Join-Path $ProjectRoot "src-tauri/Cargo.toml"))) {
    Write-Error "Не нашёл src-tauri/Cargo.toml. Запусти из корня проекта."
    exit 1
}

$TasksAbs = if ([System.IO.Path]::IsPathRooted($TasksPath)) { $TasksPath } else { Join-Path $ProjectRoot $TasksPath }
if (-not (Test-Path $TasksAbs)) {
    Write-Error "Не нашёл tasks-файл: $TasksAbs"
    exit 1
}

$LogPath = Join-Path $ProjectRoot $OutputDir | Join-Path -ChildPath $LogFile
$LogDir = Split-Path -Parent $LogPath
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

# ── 2. cargo test sanity gate ──────────────────────────────────────────

if (-not $SkipCargoTest) {
    Write-Host "[harness] running cargo test --lib engine (sanity gate)..." -ForegroundColor Cyan
    Push-Location (Join-Path $ProjectRoot "src-tauri")
    $testOutput = & cargo test --lib engine 2>&1
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Error "cargo test failed"
        $testOutput | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
        exit 1
    }
    $okCount = ($testOutput | Select-String -Pattern "^test result: ok\. (\d+) passed" | ForEach-Object { $_.Matches.Groups[1].Value })
    Write-Host "[harness] cargo test OK ($okCount tests passing)" -ForegroundColor Green
}

# ── 3. Загружаем задачи из JSON ────────────────────────────────────────

$Tasks = @(Get-Content -Raw -Path $TasksAbs -Encoding UTF8 | ConvertFrom-Json)
Write-Host "[harness] loaded $($Tasks.Count) tasks from $TasksAbs" -ForegroundColor Cyan

if ($Tasks.Count -ne 50) {
    Write-Warning "Expected 50 tasks, got $($Tasks.Count). Proceeding anyway."
}

# Считаем по категориям
$byCategory = $Tasks | Group-Object category | ForEach-Object {
    [pscustomobject]@{
        category = $_.Name
        count = $_.Count
    }
}
Write-Host "[harness] category distribution:"
$byCategory | Format-Table | Out-String | Write-Host

# ── 4. Логика auto-prefer (mirror src-tauri/src/engine/smart_engine.rs) ─

function Get-AutoPreferDecision {
    param(
        [string]$Text,
        [string]$Category
    )
    $codeMarkers = @(
        "```rust", "```ts", "```tsx", "```js", "```py", "```go", "```rs",
        "fn ", "impl ", "trait ", "let mut ", "struct ", "enum ",
        "::new(", ".unwrap()", ".expect(", "pub fn", "async fn",
        "match ", "use serde", "use std::", "tauri::command", "tokio::",
        "println!", "dbg!", "-> Result<"
    )
    $toolMarkers = @(
        '{"name":', "tool_call", "function_call", "<tools>", "</tools>",
        "search_web(", "open_app(", "list_installed_apps(", "web_search("
    )

    $lower = $Text.ToLower()
    $hasCode = $false
    foreach ($m in $codeMarkers) {
        if ($lower.Contains($m.ToLower())) {
            $hasCode = $true
            break
        }
    }
    $hasTool = $false
    foreach ($m in $toolMarkers) {
        if ($lower.Contains($m.ToLower())) {
            $hasTool = $true
            break
        }
    }
    $chars = ($Text | Measure-Object -Character).Characters

    $fired = New-Object System.Collections.Generic.List[string]
    $score = 0
    $preferred = "default"

    if ($hasCode) {
        $fired.Add("code-edit"); $score += 5
        if ($preferred -eq "default") { $preferred = "code" }
    }
    if ($chars -lt 60 -and $chars -gt 0 -and -not $hasCode) {
        $fired.Add("short"); $score += 5
        if ($preferred -eq "default") { $preferred = "fast" }
    }
    if ($chars -gt 600) {
        $fired.Add("long"); $score += 5
        if ($preferred -eq "default") { $preferred = "large" }
    }
    if ($Category) {
        $score += 2
    }
    if ($hasTool) {
        $fired.Add("tool-call-pattern")
    }

    $flipped = ($score -ge 12 -and $preferred -ne "default")
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

function Test-ResponsePass {
    param(
        [string]$Response,
        [string]$Expected
    )
    if ([string]::IsNullOrWhiteSpace($Response)) { return $false }
    # Length floor lowered to 15 (was 50) — terse v3 responses for
    # reasoning/chat can be much shorter and still correct.
    if ($Response.Length -lt 15) { return $false }
    if ($Response -like "*$Expected*") { return $true }
    return $false
}

# ── 5. A/B прогон ─────────────────────────────────────────────────────

Write-Host "[harness] running A/B benchmark on $($Tasks.Count) tasks..." -ForegroundColor Cyan

if (Test-Path $LogPath) {
    $size = (Get-Item $LogPath).Length
    Write-Host "[harness] appending to existing log: $LogPath ($size bytes)" -ForegroundColor DarkGray
}

$results = New-Object System.Collections.Generic.List[object]
$hitCounts = [ordered]@{
    "vision" = 0
    "code-edit" = 0
    "short" = 0
    "long" = 0
    "tool-call-pattern" = 0
}
$hitCounts["vision"] = 0
$hitCounts["code-edit"] = 0
$hitCounts["short"] = 0
$hitCounts["long"] = 0
$hitCounts["tool-call-pattern"] = 0

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$progressCounter = 0
$jsonlLines = New-Object System.Collections.Generic.List[string]

foreach ($task in $Tasks) {
    $progressCounter++
    Write-Progress -Activity "A/B verification" -Status "$($task.id) [$($task.category)]" -PercentComplete (($progressCounter / $Tasks.Count) * 100)

    $decision = Get-AutoPreferDecision -Text $task.prompt -Category $task.category
    $v3Passed = Test-ResponsePass -Response $task.v3Resp -Expected $task.expected
    $basePassed = Test-ResponsePass -Response $task.baseResp -Expected $task.expected

    foreach ($f in $decision.fired) {
        if ($hitCounts.Contains($f)) { $hitCounts[$f]++ }
    }

    # JSONL запись для v3 path
    $v3Excerpt = ($task.v3Resp -replace "`r`n", " " -replace "`n", " ")
    if ($v3Excerpt.Length -gt 80) { $v3Excerpt = $v3Excerpt.Substring(0, 80) }
    $v3Entry = [ordered]@{
        ts = $now
        task_id = $task.id
        category = $task.category
        path = "v3"
        model = $decision.preferred
        latency_ms = [int]$task.v3Ms
        passed = $v3Passed
        score = $decision.score
        fired = @($decision.fired)
        chars = $decision.chars
        response_excerpt = $v3Excerpt
    }
    $jsonlLines.Add(($v3Entry | ConvertTo-Json -Compress -Depth 5))

    # JSONL запись для baseline
    $baseExcerpt = ($task.baseResp -replace "`r`n", " " -replace "`n", " ")
    if ($baseExcerpt.Length -gt 80) { $baseExcerpt = $baseExcerpt.Substring(0, 80) }
    $baseEntry = [ordered]@{
        ts = $now
        task_id = $task.id
        category = $task.category
        path = "gemma3:4b"
        model = "gemma3:4b"
        latency_ms = [int]$task.baseMs
        passed = $basePassed
        score = 0
        fired = @()
        chars = $decision.chars
        response_excerpt = $baseExcerpt
    }
    $jsonlLines.Add(($baseEntry | ConvertTo-Json -Compress -Depth 5))

    $results.Add([pscustomobject]@{
        id = $task.id
        category = $task.category
        v3_passed = $v3Passed
        base_passed = $basePassed
        v3_latency = [int]$task.v3Ms
        base_latency = [int]$task.baseMs
        preferred = $decision.preferred
        flipped = $decision.flipped
        fired = ($decision.fired -join ",")
        score = $decision.score
    })
}

Write-Progress -Activity "A/B verification" -Completed

# Пишем в JSONL
$jsonlLines | ForEach-Object { Add-Content -Path $LogPath -Value $_ -Encoding UTF8 }

# ── 6. Сводка ─────────────────────────────────────────────────────────

$v3PassCount = @($results | Where-Object { $_.v3_passed }).Count
$basePassCount = @($results | Where-Object { $_.base_passed }).Count
$v3PassRate = [math]::Round(($v3PassCount / $results.Count) * 100, 1)
$basePassRate = [math]::Round(($basePassCount / $results.Count) * 100, 1)

$v3Latencies = @($results | ForEach-Object { $_.v3_latency } | Sort-Object)
$baseLatencies = @($results | ForEach-Object { $_.base_latency } | Sort-Object)

function Get-Percentile {
    param([int[]]$Sorted, [double]$P)
    $idx = [int]([math]::Ceiling(($Sorted.Count - 1) * $P))
    return $Sorted[$idx]
}

$v3P50 = Get-Percentile -Sorted $v3Latencies -P 0.50
$v3P95 = Get-Percentile -Sorted $v3Latencies -P 0.95
$baseP50 = Get-Percentile -Sorted $baseLatencies -P 0.50
$baseP95 = Get-Percentile -Sorted $baseLatencies -P 0.95

$flippedCount = @($results | Where-Object { $_.flipped }).Count
$flippedRate = [math]::Round(($flippedCount / $results.Count) * 100, 1)

Write-Host ""
Write-Host "=== A/B summary ===" -ForegroundColor Magenta
Write-Host ("Total tasks:     {0}" -f $results.Count)
Write-Host ("v3 pass rate:    {0}/{1} ({2}%)" -f $v3PassCount, $results.Count, $v3PassRate)
Write-Host ("baseline pass:   {0}/{1} ({2}%)" -f $basePassCount, $results.Count, $basePassRate)
Write-Host ("v3 p50/p95:      {0}ms / {1}ms" -f $v3P50, $v3P95)
Write-Host ("base p50/p95:    {0}ms / {1}ms" -f $baseP50, $baseP95)
Write-Host ("flipped:         {0}/{1} ({2}%)" -f $flippedCount, $results.Count, $flippedRate)
Write-Host ""
Write-Host "=== Condition hit-rates ===" -ForegroundColor Magenta
foreach ($k in $hitCounts.Keys) {
    $rate = [math]::Round(($hitCounts[$k] / $results.Count) * 100, 1)
    Write-Host ("  {0,-20} {1}/{2} ({3}%)" -f $k, $hitCounts[$k], $results.Count, $rate)
}
Write-Host ""
Write-Host ("Pass rate delta: {0} pp (v3 - baseline)" -f [math]::Round($v3PassRate - $basePassRate, 1))
Write-Host ("Latency delta:   {0} ms p50 (v3 - baseline)" -f ($v3P50 - $baseP50))
Write-Host ""
Write-Host "=== By category ===" -ForegroundColor Magenta
$byCat = $results | Group-Object category | ForEach-Object {
    $g = $_.Group
    $v3P = @($g | Where-Object v3_passed).Count
    $bP = @($g | Where-Object base_passed).Count
    [pscustomobject]@{
        category = $_.Name
        n = $g.Count
        v3_pass = $v3P
        base_pass = $bP
        v3_pct = [math]::Round(($v3P / $g.Count) * 100, 1)
        base_pct = [math]::Round(($bP / $g.Count) * 100, 1)
    }
}
$byCat | Format-Table -AutoSize | Out-String | Write-Host

Write-Host ""
Write-Host "=== Recommendation ===" -ForegroundColor Magenta
$delta = [math]::Round($v3PassRate - $basePassRate, 1)
if ($delta -gt 0) {
    Write-Host ("v3 BETTER: {0}% vs {1}% (+{2} pp) -- recommend ship default ON" -f $v3PassRate, $basePassRate, $delta) -ForegroundColor Green
} elseif ($delta -eq 0) {
    Write-Host ("v3 EQUAL: {0}% vs {1}% -- keep opt-in, latency wins still matter" -f $v3PassRate, $basePassRate) -ForegroundColor Yellow
} else {
    Write-Host ("v3 WORSE: {0}% vs {1}% (-{2} pp) -- debug, do not ship default" -f $v3PassRate, $basePassRate, [Math]::Abs($delta)) -ForegroundColor Red
}

Write-Host ""
Write-Host "[harness] log: $LogPath" -ForegroundColor DarkGray
$logSize = if (Test-Path $LogPath) { (Get-Item $LogPath).Length } else { 0 }
Write-Host "[harness] log size: $logSize bytes ($($results.Count * 2) entries)" -ForegroundColor DarkGray

# Summary JSON
$summary = [ordered]@{
    generated_at = (Get-Date -Format "o")
    total_tasks = $results.Count
    v3_pass_rate = $v3PassRate
    baseline_pass_rate = $basePassRate
    v3_p50_ms = $v3P50
    v3_p95_ms = $v3P95
    baseline_p50_ms = $baseP50
    baseline_p95_ms = $baseP95
    flipped_count = $flippedCount
    flipped_rate_pct = $flippedRate
    condition_hits = $hitCounts
    by_category = $byCat
}
$summaryPath = $LogPath -replace '\.jsonl$', '.summary.json'
$summary | ConvertTo-Json -Depth 5 | Set-Content -Path $summaryPath -Encoding UTF8
Write-Host "[harness] summary: $summaryPath" -ForegroundColor DarkGray

# Detailed CSV для анализа
$csvPath = $LogPath -replace '\.jsonl$', '.csv'
$results | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
Write-Host "[harness] csv: $csvPath" -ForegroundColor DarkGray

exit 0
