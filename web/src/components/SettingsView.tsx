// Pulse v5.1 — Settings view.
//
// Что внутри:
//  • Выбор text-модели (для обычного чата, tool-use, Smart Engine).
//  • Выбор vision-модели (для скриншотов / прикреплённых картинок).
//  • Theme picker (dark-only, R96b).
//  • Capabilities preview (vision / tools) — на основе имени модели через
//    эвристику `getModelCapabilities` (см. llm/client.ts).
//
// Persist: localStorage `pulse.model.override` и `pulse.visionModel.override`.
// При первом запуске — пустые (т.е. берутся env VITE_LLM_MODEL / VITE_LLM_VISION_MODEL).
//
// R96b: light theme option removed. Pulse — dark-only by design (R95 Designer
// audit §3.1 D1, Roman's hard rule #1). 'light' больше не присутствует в UI
// и в Theme type (см. mobile/theme.ts). Light CSS в styles.css оставлен как
// dead code — он не активируется без data-theme="light", который никто не
// выставляет. Полная зачистка = R97+ scope.
//
// Version display: тянется из import.meta.env.VITE_APP_VERSION, который
// прокидывается через `define` в vite.config.ts из package.json. Single
// source of truth — больше не нужно править строку вручную на каждом релизе.

import { useEffect, useMemo, useState } from 'react';
import {
  capabilitiesOf,
  getLLMConfig,
  getActiveTextModel,
  getActiveVisionModel,
} from '../llm/client';
import type { ModelCapabilities } from '../llm/types';
import { readTheme, writeTheme, applyTheme, type Theme } from '../mobile/theme';
import { IS_MOBILE, IS_DESKTOP } from '../api';
import { resetOnboarding } from '../mobile/Onboarding';
import { resetOnboarding as resetDesktopOnboarding } from './Onboarding';
import { ProRequiredError } from '../lib/license/types';
import { licenseStore } from '../lib/license/store';
import { PRO_FEATURES } from '../lib/pro-features';
import { UpgradeModal } from './PRO/UpgradeModal';
import { PROSettings } from './settings/PROSettings';

const LS_MODEL = 'pulse.model.override';
const LS_VISION = 'pulse.visionModel.override';

/** Пресет моделей: имя + короткое описание + capabilities.
 *  Vision-чек идёт через `capabilitiesOf` — тут только метаданные для UI. */
const PRESETS: Array<{ name: string; label: string; hint: string }> = [
  { name: 'gemma2:2b',         label: 'gemma2:2b',         hint: 'лёгкая text-only (1.6 ГБ, по умолчанию)' },
  { name: 'gemma3:4b',         label: 'gemma3:4b',         hint: 'vision + text, Google (март 2025, 4B, ~3.3 ГБ)' },
  { name: 'qwen2.5:3b',        label: 'qwen2.5:3b',        hint: 'text, неплохой reasoning (~2 ГБ)' },
  { name: 'llama3.2:3b',       label: 'llama3.2:3b',       hint: 'text, Meta (~2 ГБ)' },
  { name: 'llama3.2-vision:11b', label: 'llama3.2-vision:11b', hint: 'vision + text, тяжёлая (~7 ГБ)' },
  { name: 'llava:7b',          label: 'llava:7b',          hint: 'vision + text, классика (~4 ГБ)' },
  { name: 'minicpm-v:8b',      label: 'minicpm-v:8b',      hint: 'vision + text, OpenBMB (~5 ГБ)' },
];

function readLS(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function writeLS(key: string, value: string) {
  try {
    if (value && value.trim()) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function Cap({ cap, kind }: { cap: ModelCapabilities; kind: 'vision' | 'tools' }) {
  const on = cap[kind];
  return (
    <span
      className={`settings__cap${kind === 'vision' ? ' settings__cap--vision' : ''}`}
      data-on={on ? '1' : '0'}
      title={kind === 'vision' ? 'Понимает картинки (image_url)' : 'Нативный tool-use через OpenAI tools'}
    >
      {kind === 'vision' ? '🖼️ vision' : '🛠 tools'}
    </span>
  );
}

function ModelCaps({ model }: { model: string }) {
  const cap = useMemo(() => capabilitiesOf(model), [model]);
  if (!model) {
    return <span className="settings__hint">— модель не выбрана —</span>;
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <Cap cap={cap} kind="vision" />
      <Cap cap={cap} kind="tools" />
    </span>
  );
}

export function SettingsView({ onShowWelcomeTour }: { onShowWelcomeTour?: () => void } = {}) {
  // Снимок env-конфига при монтировании (для дефолтов в селекте).
  const initial = useMemo(() => {
    const cfg = getLLMConfig();
    return {
      envModel: cfg.model,
      envVision: cfg.visionModel,
      lsModel: readLS(LS_MODEL),
      lsVision: readLS(LS_VISION),
    };
  }, []);

  const [textModel, setTextModel] = useState<string>(
    initial.lsModel || initial.envModel,
  );
  const [visionModel, setVisionModel] = useState<string>(
    initial.lsVision || initial.envVision,
  );
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // R119: PRO gate modal — surfaced when a free user tries to hot-swap to
  // a non-default model.
  const [multiModelGate, setMultiModelGate] = useState<string | null>(null);

  // Если список пресетов не содержит текущую модель — добавляем её как custom
  const textOptions = useMemo(() => {
    if (PRESETS.some((p) => p.name === textModel)) return PRESETS;
    return [...PRESETS, { name: textModel, label: `${textModel} (custom)`, hint: 'пользовательская' }];
  }, [textModel]);
  const visionOptions = useMemo(() => {
    if (PRESETS.some((p) => p.name === visionModel)) return PRESETS;
    return [...PRESETS, { name: visionModel, label: `${visionModel} (custom)`, hint: 'пользовательская' }];
  }, [visionModel]);

  // Прячем saved-флажок через 2 сек
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  function onSave() {
    setErr(null);
    try {
      writeLS(LS_MODEL, textModel);
      writeLS(LS_VISION, visionModel);
      writeTheme(theme);
      applyTheme(theme);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // R119: hot-swap to a different model is a PRO feature. The dropdowns above
  // stay free (one text + one vision at a time). The "Hot-swap" chips below
  // give a quick action that lets the user pick any preset and persist it;
  // free users see the modal instead.
  function tryHotSwap(model: string) {
    try {
      licenseStore.requirePro('multi-model');
      writeLS(LS_MODEL, model);
      setTextModel(model);
      setSaved(true);
    } catch (e) {
      if (e instanceof ProRequiredError) {
        setMultiModelGate(model);
        return;
      }
      setErr((e as Error).message);
    }
  }

  function onReset() {
    setTextModel(initial.envModel);
    setVisionModel(initial.envVision);
    writeLS(LS_MODEL, '');
    writeLS(LS_VISION, '');
    setSaved(true);
  }

  function onThemeChange(t: Theme) {
    setTheme(t);
    // theme применяем сразу, без ожидания «Сохранить» — так привычнее
    writeTheme(t);
    applyTheme(t);
  }

  // Модели, которые уже активны (после override / env)
  const activeText = getActiveTextModel();
  const activeVision = getActiveVisionModel();

  return (
    <div className="settings">
      <div className="settings__section">
        <div className="settings__title">LLM — text (чат, Smart Engine)</div>
        <div className="settings__row">
          <div className="settings__label">Модель</div>
          <div className="settings__field">
            <select
              className="settings__select"
              value={textModel}
              onChange={(e) => setTextModel(e.target.value)}
            >
              {textOptions.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
            <ModelCaps model={textModel} />
          </div>
        </div>
        <div className="settings__hint">
          Активна сейчас: <code>{activeText}</code> (env: <code>{initial.envModel}</code>
          {initial.lsModel ? `, override: <code>${initial.lsModel}</code>` : ''}).
          <br />
          Изменения вступают в силу на следующем сообщении.
        </div>
      </div>

      <div className="settings__section">
        <div className="settings__title">LLM — vision (скриншоты, прикреплённые картинки)</div>
        <div className="settings__row">
          <div className="settings__label">Модель</div>
          <div className="settings__field">
            <select
              className="settings__select"
              value={visionModel}
              onChange={(e) => setVisionModel(e.target.value)}
            >
              {visionOptions.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
            <ModelCaps model={visionModel} />
          </div>
        </div>
        <div className="settings__hint">
          Активна сейчас: <code>{activeVision}</code> (env: <code>{initial.envVision}</code>
          {initial.lsVision ? `, override: <code>${initial.lsVision}</code>` : ''}).
          <br />
          Скачать в Ollama: <code>ollama pull {visionModel}</code>.
          <br />
          Если в сообщении есть картинка — клиент автоматически выберет vision-модель.
        </div>
      </div>

      <div className="settings__section">
        <div className="settings__title">Тема оформления</div>
        <div className="settings__row">
          <div className="settings__label">Тема</div>
          <div className="settings__field">
            <select
              className="settings__select"
              value={theme}
              onChange={(e) => onThemeChange(e.target.value as Theme)}
            >
              {/* Pulse is dark-only by design (Roman's hard rule #1).
                  Light option removed in R96b. */}
              <option value="dark">🌙 Тёмная</option>
              <option value="system">🖥 Системная (всегда dark)</option>
            </select>
          </div>
        </div>
        <div className="settings__hint">
          Тема применяется мгновенно. Persist в localStorage <code>pulse.theme</code>.
          Pulse — dark-only; «Системная» всегда даёт тёмную.
        </div>
      </div>

      <div className="settings__section">
        <div className="settings__title">First-run tour</div>
        <div className="settings__hint">
          Pulse shows a 3-step welcome tour on first launch. Reopen it any time.
        </div>
        <div className="settings__row">
          <div className="settings__label">Welcome tour</div>
          <div className="settings__field">
            <button
              type="button"
              className="settings__save"
              style={{ background: 'var(--bg-elev)', color: 'var(--fg)' }}
              onClick={() => {
                resetDesktopOnboarding();
                if (onShowWelcomeTour) {
                  onShowWelcomeTour();
                } else {
                  setSaved(true);
                }
              }}
            >
              Show welcome tour again
            </button>
            {!onShowWelcomeTour && saved && (
              <span className="settings__hint" style={{ marginLeft: 8 }}>
                Reopen the app to see the tour.
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="settings__section">
        <div className="settings__title">About / Справка</div>
        <div className="settings__hint">
          <b>Pulse</b> v{import.meta.env.VITE_APP_VERSION} · mobile-iteration 17
          <br />
          Среда:{' '}
          <code>
            {IS_DESKTOP ? 'desktop (Tauri)' : IS_MOBILE ? 'mobile (Capacitor)' : 'web'}
          </code>
          <br />
          {IS_MOBILE && (
            <>
              <button
                type="button"
                className="settings__save"
                style={{ marginTop: 6, background: 'var(--bg-elev)', color: 'var(--fg)' }}
                onClick={() => {
                  resetOnboarding();
                  setSaved(true);
                }}
              >
                🔄 Показать onboarding заново
              </button>
              <br />
            </>
          )}
          <a
            href="https://ollama.com"
            target="_blank"
            rel="noreferrer noopener"
          >
            Ollama (локальный LLM)
          </a>
          {' · '}
          <a
            href="https://play.google.com/store/apps/details?id=ai.cursor.Ollama"
            target="_blank"
            rel="noreferrer noopener"
          >
            Play Store
          </a>
        </div>
      </div>

      <div className="settings__section">
        <div className="settings__title">Endpoints & key</div>
        <div className="settings__hint">
          Base URL и API-ключ задаются через <code>.env</code> в корне проекта:
          <br />
          <code>VITE_LLM_BASE_URL</code>, <code>VITE_LLM_API_KEY</code>,
          <code>VITE_LLM_MODEL</code>, <code>VITE_LLM_VISION_MODEL</code>.
          <br />
          После правки <code>.env</code> — перезапусти <code>npm run tauri dev</code>.
        </div>
      </div>

      {/* R119: hot-swap presets. Gated by `requirePro('multi-model')` in
          `tryHotSwap`. Free users see the chips but the click triggers the
          upgrade modal — they can still use the dropdowns above. */}
      <div className="settings__section">
        <div className="settings__title">Hot-swap presets (PRO)</div>
        <div className="settings__hint">
          {PRO_FEATURES['multi-model'].hint}
        </div>
        <div className="settings__chips">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className={`settings__chip${textModel === p.name ? ' settings__chip--active' : ''}`}
              onClick={() => tryHotSwap(p.name)}
              title={p.hint}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* R119: PRO license section — paste-key input / status / sign out. */}
      <div className="settings__section">
        <PROSettings />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="settings__save" onClick={onSave} type="button">
          Сохранить
        </button>
        <button
          className="settings__save"
          onClick={onReset}
          type="button"
          style={{ background: 'var(--bg-elev)', color: 'var(--fg)' }}
        >
          Сбросить override
        </button>
        {saved && <span className="settings__ok">✓ сохранено</span>}
        {err && <span className="settings__err">{err}</span>}
      </div>

      {multiModelGate && (
        <UpgradeModal
          feature="multi-model"
          reason="click"
          onClose={() => setMultiModelGate(null)}
        />
      )}
    </div>
  );
}
