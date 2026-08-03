// SPDX-License-Identifier: Apache-2.0
// Pulse R175 — Settings → About → «Your hardware» section.
//
// Что показывает:
//   1) Снимок железа (CPU cores/brand, RAM, GPU из WebGL, OS, screen, язык).
//      Источник — Tauri `detect_hardware` (HardwareSpec) + web-детектор
//      `hardwareDetector.ts` (WebGL GPU + screen DPI + language).
//   2) 1-3 рекомендации Ollama-модели под это железо (modelRecommender).
//      Каждая карточка: имя + назначение + команда `ollama pull ...` с
//      copy-to-clipboard.
//
// Поведение:
//   * Кнопка «Refresh» — повторно вызывает detectHardware() и обновляет state.
//   * На web (не Tauri) — `detectHardware()` из api.ts возвращает
//     «unknown» HardwareSpec, поэтому мы заполняем поля из web-детектора
//     (`detectHardware()` из lib/hardwareDetector.ts).
//   * Копирование в clipboard — через `@tauri-apps/plugin-clipboard-manager`
//     если Tauri, иначе `navigator.clipboard.writeText()` с fallback.

import { useCallback, useEffect, useState } from 'react';
import { detectHardware as tauriDetect, IS_DESKTOP } from '../../api';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { HardwareSpec } from '../../types';
import {
  detectHardware as webDetect,
  type HardwareInfo,
} from '../../lib/hardwareDetector';
import {
  recommendModelFromInfo,
  recommendModel,
  type ModelRecommendation,
} from '../../lib/modelRecommender';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

interface CombinedView {
  /** CPU brand + cores. */
  cpuLine: string;
  /** RAM в ГБ. */
  ramLine: string;
  /** GPU из WebGL. */
  gpuLine: string;
  /** OS. */
  osLine: string;
  /** Screen + DPI. */
  screenLine: string;
  /** Tier (Low/Mid/High/Ultra) — для бейджа. */
  tier: string;
}

const UNKNOWN = 'unknown';

/** Склеивает Tauri HardwareSpec + web HardwareInfo в плоский view для UI. */
function buildView(spec: HardwareSpec | null, info: HardwareInfo): CombinedView {
  if (spec) {
    const brand = spec.cpu.brand || UNKNOWN;
    const cores = spec.cpu.cores || info.cpu.cores;
    const coresText = typeof cores === 'number' ? `${cores} cores` : '';
    const cpuLine = [brand, coresText].filter(Boolean).join(' · ') || UNKNOWN;
    const ramText = spec.ram.total_gb > 0
      ? `${spec.ram.total_gb.toFixed(1)} GB`
      : (typeof info.ram === 'number' ? `${info.ram} GB` : UNKNOWN);
    const gpuText = info.gpu ? `${info.gpu.vendor} · ${info.gpu.renderer}` : UNKNOWN;
    const osText = spec.os.name && spec.os.name !== UNKNOWN
      ? `${spec.os.name} ${spec.os.version}`.trim()
      : info.os;
    const screenText = info.screen.width > 0
      ? `${info.screen.width}×${info.screen.height} @ ${info.screen.dpi}x`
      : UNKNOWN;
    return {
      cpuLine,
      ramLine: ramText,
      gpuLine: gpuText,
      osLine: osText,
      screenLine: screenText,
      tier: spec.recommended_tier,
    };
  }
  // Web-only: данных из Tauri нет. Используем только web.
  const cores = info.cpu.cores;
  const coresText = typeof cores === 'number' ? `${cores} cores` : '';
  return {
    cpuLine: [info.cpu.model, coresText].filter(Boolean).join(' · ') || UNKNOWN,
    ramLine: typeof info.ram === 'number' ? `${info.ram} GB` : UNKNOWN,
    gpuLine: info.gpu ? `${info.gpu.vendor} · ${info.gpu.renderer}` : UNKNOWN,
    osLine: info.os,
    screenLine: info.screen.width > 0
      ? `${info.screen.width}×${info.screen.height} @ ${info.screen.dpi}x`
      : UNKNOWN,
    tier: 'Low',
  };
}

/** Какие рекомендации показывать. Если Tauri-источник дал RAM — берём из него,
 *  иначе — из web-детектора. */
function buildRecommendations(
  spec: HardwareSpec | null,
  info: HardwareInfo,
): ModelRecommendation[] {
  if (spec && spec.ram.total_gb > 0) {
    return recommendModel({
      ramGb: spec.ram.total_gb,
      // VRAM — Tauri MVP всегда [] (пусто). Если web-детектор дал что-то
      // осмысленное, берём оттуда; иначе null.
      vramGb: null,
    });
  }
  return recommendModelFromInfo(info);
}

export function HardwareSection() {
  const [state, setState] = useState<LoadState>('idle');
  const [spec, setSpec] = useState<HardwareSpec | null>(null);
  const [info, setInfo] = useState<HardwareInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState('loading');
    try {
      // Параллельно: Tauri-spec + web-info. Web-info — даже на Tauri нужен
      // ради WebGL GPU (MVP Rust gpus=[]).
      const [tSpec, tInfo] = await Promise.all([
        tauriDetect().catch(() => null),
        webDetect(),
      ]);
      setSpec(tSpec);
      setInfo(tInfo);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onCopy = useCallback(async (cmd: string) => {
    try {
      if (IS_DESKTOP) {
        // Tauri: плагин clipboard-manager (статический импорт — FilesView
        // тоже его дёргает, динамический импорт дублировал бы chunk).
        await writeText(cmd);
      } else if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(cmd);
      } else {
        // Старый fallback — textarea + execCommand. На современных
        // браузерах execCommand считается deprecated, но работает.
        const ta = document.createElement('textarea');
        ta.value = cmd;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(cmd);
      setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1500);
    } catch {
      // Тихая ошибка — UI не должен ломаться на копировании.
    }
  }, []);

  if (state === 'loading' && !info) {
    return (
      <div className="settings__section">
        <div className="settings__title">Your hardware</div>
        <div className="settings__hint">Detecting…</div>
      </div>
    );
  }
  if (state === 'error' || !info) {
    return (
      <div className="settings__section">
        <div className="settings__title">Your hardware</div>
        <div className="settings__hint">
          Hardware detection failed. Click Refresh to retry.
        </div>
        <button
          type="button"
          className="settings__save"
          onClick={refresh}
          aria-label="Refresh hardware detection"
        >
          Refresh
        </button>
      </div>
    );
  }

  const view = buildView(spec, info);
  const recs = buildRecommendations(spec, info);

  return (
    <div className="settings__section" data-testid="hardware-section">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div className="settings__title">Your hardware</div>
        <button
          type="button"
          className="settings__save"
          onClick={refresh}
          aria-label="Refresh hardware detection"
          disabled={state === 'loading'}
          style={{ minHeight: 56, minWidth: 56 }}
        >
          {state === 'loading' ? '…' : 'Refresh'}
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '110px 1fr',
          rowGap: 6,
          columnGap: 12,
          margin: '10px 0 6px',
          fontSize: 13,
        }}
      >
        <div style={{ color: 'var(--fg-dim, #565f89)' }}>Tier</div>
        <div>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 10,
              background: 'var(--bg-elev, #1f2335)',
              border: '1px solid var(--border, #414868)',
              color: 'var(--fg, #c0caf5)',
            }}
          >
            {view.tier}
          </span>
        </div>
        <div style={{ color: 'var(--fg-dim, #565f89)' }}>CPU</div>
        <div data-testid="hw-cpu">{view.cpuLine}</div>
        <div style={{ color: 'var(--fg-dim, #565f89)' }}>RAM</div>
        <div data-testid="hw-ram">{view.ramLine}</div>
        <div style={{ color: 'var(--fg-dim, #565f89)' }}>GPU</div>
        <div data-testid="hw-gpu">{view.gpuLine}</div>
        <div style={{ color: 'var(--fg-dim, #565f89)' }}>OS</div>
        <div data-testid="hw-os">{view.osLine}</div>
        <div style={{ color: 'var(--fg-dim, #565f89)' }}>Screen</div>
        <div data-testid="hw-screen">{view.screenLine}</div>
      </div>

      <div className="settings__hint">
        Detected via {IS_DESKTOP ? 'Tauri + WebGL' : 'browser APIs'}.
        {IS_DESKTOP && ' GPU info comes from WebGL (Tauri MVP does not enumerate GPU yet).'}
      </div>

      <div style={{ marginTop: 14, fontSize: 13, color: 'var(--fg-dim, #565f89)' }}>
        Recommended models for your hardware
      </div>
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: '8px 0 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
        aria-label="Recommended Ollama models"
      >
        {recs.map((r) => (
          <li
            key={r.name}
            data-testid="hw-model-card"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              minHeight: 56,
              background: 'var(--bg-elev, #1f2335)',
              border: '1px solid var(--border, #414868)',
              borderRadius: 10,
            }}
          >
            <div style={{ flex: '0 0 auto', minWidth: 130, fontWeight: 600 }}>
              {r.name}
            </div>
            <div
              style={{
                flex: 1,
                color: 'var(--fg-dim, #565f89)',
                fontSize: 12,
              }}
            >
              {r.bestFor} · ≈{r.vram} GB
            </div>
            <code
              data-testid="hw-install-cmd"
              style={{
                flex: '0 1 auto',
                fontSize: 11,
                padding: '4px 8px',
                background: 'rgba(0,0,0,0.2)',
                borderRadius: 4,
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.installCommand}
            </code>
            <button
              type="button"
              onClick={() => onCopy(r.installCommand)}
              aria-label={`Copy ${r.installCommand}`}
              data-testid="hw-copy-btn"
              style={{
                minHeight: 56,
                minWidth: 56,
                padding: '6px 12px',
                background: 'var(--accent, #7aa2f7)',
                color: '#0f111a',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              {copied === r.installCommand ? 'Copied' : 'Copy'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
