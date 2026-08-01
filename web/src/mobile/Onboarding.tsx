// Pulse mobile-iteration 17 — Onboarding screen.
//
// Показывается один раз при первом запуске на мобильном (Capacitor WebView).
// Persist в localStorage `pulse.onboarding.done`.
// Не показывается в Tauri-десктопе и в web-браузере (только mobile).
//
// Шаги:
//   1) Welcome to Pulse
//   2) Где взять Ollama (https://ollama.com + ссылка на Play Store)
//   3) Готово → закрыть

import { useState } from 'react';
import { IS_MOBILE } from '../api';

const LS_DONE = 'pulse.onboarding.done';
const LS_VERSION = 'pulse.onboarding.version';
const CURRENT_VERSION = '17'; // bump чтобы пере-показать при крупных изменениях

export function isOnboardingDone(): boolean {
  try {
    const done = localStorage.getItem(LS_DONE);
    const ver = localStorage.getItem(LS_VERSION);
    return done === '1' && ver === CURRENT_VERSION;
  } catch {
    return false;
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(LS_DONE, '1');
    localStorage.setItem(LS_VERSION, CURRENT_VERSION);
  } catch {
    /* ignore */
  }
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(LS_DONE);
    localStorage.removeItem(LS_VERSION);
  } catch {
    /* ignore */
  }
}

interface Step {
  emoji: string;
  title: string;
  body: React.ReactNode;
}

const STEPS: Step[] = [
  {
    emoji: '👋',
    title: 'Добро пожаловать в Pulse',
    body: (
      <>
        Pulse — локальный AI-ассистент. Чат, поиск по Habr, файлы и агенты —
        прямо на твоём телефоне. Без облака, без подписок.
      </>
    ),
  },
  {
    emoji: '🧠',
    title: 'Pulse работает на Ollama',
    body: (
      <>
        Чтобы чат ожил, поставь <b>Ollama</b> на этот же телефон (или в сети).
        <br />
        <br />
        <a href="https://ollama.com" target="_blank" rel="noreferrer noopener">
          ollama.com
        </a>
        {' · '}
        <a
          href="https://play.google.com/store/apps/details?id=ai.cursor.Ollama"
          target="_blank"
          rel="noreferrer noopener"
        >
          Play Store
        </a>
        <br />
        <br />
        После установки выполни:
        <br />
        <code>ollama pull gemma2:2b</code>
        <br />
        <code>ollama serve</code>
      </>
    ),
  },
  {
    emoji: '🚀',
    title: 'Готово к запуску',
    body: (
      <>
        Нижние вкладки: <b>Чат</b>, <b>Habr</b>, <b>Файлы</b>, <b>Настройки</b>.
        <br />
        <br />
        Тащи список вниз — обновится. Микрофон в чате — голосовой ввод.
        <br />
        <br />
        Если что-то не работает — настройки → смени модель или эндпоинт.
      </>
    ),
  },
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const cur = STEPS[step]!;

  function next() {
    if (isLast) {
      markOnboardingDone();
      onDone();
    } else {
      setStep(step + 1);
    }
  }
  function prev() {
    if (step > 0) setStep(step - 1);
  }

  return (
    <div className="onb" role="dialog" aria-label="Pulse onboarding">
      <div className="onb__card">
        <div className="onb__emoji" aria-hidden>
          {cur.emoji}
        </div>
        <h1 className="onb__title">{cur.title}</h1>
        <div className="onb__body">{cur.body}</div>
        <div className="onb__dots" aria-hidden>
          {STEPS.map((_, i) => (
            <span key={i} className={`onb__dot${i === step ? ' is-active' : ''}`} />
          ))}
        </div>
        <div className="onb__nav">
          {step > 0 ? (
            <button type="button" className="onb__btn onb__btn--ghost" onClick={prev}>
              ← Назад
            </button>
          ) : (
            <button
              type="button"
              className="onb__btn onb__btn--ghost"
              onClick={() => {
                markOnboardingDone();
                onDone();
              }}
            >
              Пропустить
            </button>
          )}
          <button type="button" className="onb__btn onb__btn--primary" onClick={next}>
            {isLast ? 'Поехали →' : 'Далее →'}
          </button>
        </div>
        <div className="onb__hint">
          {IS_MOBILE ? 'Mobile (Capacitor)' : 'Web'} · v{CURRENT_VERSION}
        </div>
      </div>
    </div>
  );
}
