import { useState, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ChatView } from './components/ChatView';
import { HabrSearch } from './components/HabrSearch';
import { FilesView } from './components/FilesView';
import { AgentPanel } from './components/AgentPanel';
import { SettingsView } from './components/SettingsView';
import { WebSearchView } from './components/WebSearchView';
import {
  hideWindow,
  IS_MOBILE,
  setupCapacitorAppBackButton,
  setupCapacitorKeyboard,
  capExitApp,
} from './api';
import { Onboarding, isOnboardingDone } from './mobile/Onboarding';
import {
  Onboarding as DesktopOnboarding,
  isOnboardingDone as isDesktopOnboardingDone,
} from './components/Onboarding';
import { applyTheme, readTheme } from './mobile/theme';
import { licenseStore } from './lib/license/store';
import { getActiveTextModel } from './llm/client';

type View = 'chat' | 'agent' | 'files' | 'habr' | 'web' | 'settings';
type OllamaStatus =
  | { kind: 'pending' }
  | { kind: 'ok' }
  | { kind: 'err'; msg: string };

interface NavTab {
  id: View;
  label: string;
  icon: string;
}

const NAV_TABS: NavTab[] = [
  { id: 'chat',     label: 'Чат',         icon: '💬' },
  { id: 'agent',    label: 'Запустить',   icon: '▶️' },
  { id: 'files',    label: 'Файлы',       icon: '📁' },
  { id: 'habr',     label: 'Habr',        icon: '🔍' },
  { id: 'web',      label: 'Web',         icon: '🌐' },
  { id: 'settings', label: 'Настройки',   icon: '⚙' },
];

export function App() {
  const [view, setView] = useState<View>('chat');
  const [ollama, setOllama] = useState<OllamaStatus>({ kind: 'pending' });
  // Юзер может закрыть error-баннер крестиком (раньше он висел на всех табах
  // и не сбрасывался при смене вкладки — отсюда жалоба Дизайнера).
  // При приходе ollama-ready / ollama-failed — сбрасываем dismissed в false.
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Onboarding: показывается один раз на mobile при первом запуске.
  const [showOnboarding, setShowOnboarding] = useState(() => IS_MOBILE && !isOnboardingDone());

  // R161: desktop (Windows) first-run welcome tour. Mobile has its own
  // onboarding above; this one is gated to Tauri only and uses a different
  // localStorage key so the two surfaces stay independent.
  const [showDesktopOnboarding, setShowDesktopOnboarding] = useState(
    () => !IS_MOBILE && !isDesktopOnboardingDone(),
  );

  // ─── Theme (dark/system) — Pulse is dark-only, R96b ───────────────
  useEffect(() => {
    const t = readTheme();
    const cleanup = applyTheme(t);
    // пересоздаём подписку при изменении localStorage (theme-picker в Settings)
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'pulse.theme') {
        cleanup();
        applyTheme(readTheme());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      cleanup();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // ─── R119: cold-start license load ─────────────────────────────────
  // Hydrate the license store from disk. If the file is missing, free tier.
  // If it's tampered (GCM tag mismatch), the store clears it and falls
  // back to free. Either way, the app boots — license issues never block
  // the UI.
  useEffect(() => {
    void licenseStore.load();
  }, []);

  // ─── Capacitor init (back button + keyboard) ─────────────────────────
  useEffect(() => {
    if (!IS_MOBILE) return;
    void setupCapacitorKeyboard();
    void setupCapacitorAppBackButton(() => {
      // TODO: когда появятся вложенные роуты — здесь проверять «историю».
      // Пока единственный экран — выходим из приложения.
      void capExitApp();
    });
  }, []);

  // Если из трея пришло "open settings" — показываем панель и вкладку настроек.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    (async () => {
      try {
        unlisten = await listen('tray-open-settings', () => {
          setView('settings');
        });
      } catch {
        // вне Tauri — игнорируем
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // Ollama sidecar status: pending → ok | err. Бэкенд эмитит ровно одно из
  // событий (если ollama уже поднята — сразу ok; иначе — после spawn + probe).
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    (async () => {
      try {
        unlisteners.push(
          await listen('ollama-ready', () => {
            setOllama({ kind: 'ok' });
            setBannerDismissed(false);
          }),
        );
        unlisteners.push(
          await listen<string>('ollama-failed', (e) => {
            setOllama({ kind: 'err', msg: e.payload });
            setBannerDismissed(false);
          }),
        );
      } catch {
        // вне Tauri — игнорируем
      }
    })();
    return () => {
      for (const u of unlisteners) u();
    };
  }, []);

  const ollamaLabel =
    ollama.kind === 'ok'
      ? 'Ollama OK'
      : ollama.kind === 'pending'
        ? 'Ollama…'
        : 'Ollama error';
  // В pending/ok состоянии префикс "Ollama:" в тултипе лишний — он и так
  // написан в label. В err — наоборот, детальный msg полезнее.
  const ollamaTitle =
    ollama.kind === 'err' ? ollama.msg : ollamaLabel;

  return (
    <div className="app">
      {showOnboarding && (
        <Onboarding
          onDone={() => {
            setShowOnboarding(false);
          }}
        />
      )}
      {showDesktopOnboarding && (
        <DesktopOnboarding
          currentModel={getActiveTextModel()}
          ollamaStatus={ollama.kind}
          onDone={() => {
            setShowDesktopOnboarding(false);
          }}
          onOpenSettings={() => {
            setView('settings');
            setShowDesktopOnboarding(false);
          }}
        />
      )}
      {/* Header: перетаскивается за счёт data-tauri-drag-region (desktop only) */}
      <header className="app__header" data-tauri-drag-region>
        <img
          className="app__logo"
          src="/icons/icon.png"
          alt=""
          data-tauri-drag-region
        />
        <span className="app__title" data-tauri-drag-region>Pulse</span>
        <span
          className={`app__ollama app__ollama--${ollama.kind}`}
          title={ollamaTitle}
          aria-label={ollamaTitle}
        >
          <span className="app__ollama-dot" aria-hidden />
          <span className="app__ollama-text">{ollamaLabel}</span>
        </span>
        <span className="app__spacer" data-tauri-drag-region />
        {/* hideWindow — desktop-only feature; скрыт на mobile в CSS */}
        <button
          className="app__iconbtn app__iconbtn--autostart"
          title="Свернуть в трей"
          onClick={() => {
            void hideWindow();
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden
          >
            <path
              d="M3 5L7 9L11 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </header>

      {/* Desktop tabs (скрыты на mobile через @media (max-width: 767px)) */}
      <nav className="app__tabs">
        <button
          className={`app__tab ${view === 'chat' ? 'is-active' : ''}`}
          onClick={() => setView('chat')}
        >
          💬 Чат
        </button>
        <button
          className={`app__tab ${view === 'agent' ? 'is-active' : ''}`}
          onClick={() => setView('agent')}
        >
          Запустить
        </button>
        <button
          className={`app__tab ${view === 'files' ? 'is-active' : ''}`}
          onClick={() => setView('files')}
        >
          📁 Файлы
        </button>
        <button
          className={`app__tab ${view === 'habr' ? 'is-active' : ''}`}
          onClick={() => setView('habr')}
        >
          🔍 Habr
        </button>
        <button
          className={`app__tab ${view === 'web' ? 'is-active' : ''}`}
          onClick={() => setView('web')}
        >
          🌐 Web
        </button>
        <button
          className={`app__tab ${view === 'settings' ? 'is-active' : ''}`}
          onClick={() => setView('settings')}
        >
          Настройки
        </button>
      </nav>

      {/* Mobile bottom nav (виден только на mobile через @media) */}
      <nav className="app__nav" aria-label="Навигация">
        {NAV_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`app__navbtn ${view === t.id ? 'is-active' : ''}`}
            onClick={() => setView(t.id)}
            aria-current={view === t.id ? 'page' : undefined}
          >
            <span className="app__navbtn-emoji" aria-hidden>
              {t.icon}
            </span>
            <span className="app__navbtn-label">{t.label}</span>
          </button>
        ))}
      </nav>

      {ollama.kind === 'err' && !bannerDismissed && (
        <div className="app__banner" role="alert">
          <span className="app__banner-title">Ollama не поднялась.</span>
          <span className="app__banner-msg">
            Можешь запустить вручную: <code>ollama serve</code>. Чат будет работать,
            когда ollama станет доступна.
          </span>
          {ollama.msg && (
            <span className="app__banner-detail" title={ollama.msg}>
              {ollama.msg}
            </span>
          )}
          <button
            type="button"
            className="app__banner-close"
            title="Закрыть"
            aria-label="Закрыть уведомление"
            onClick={() => setBannerDismissed(true)}
          >
            ✕
          </button>
        </div>
      )}

      <main className="app__main">
        {view === 'chat' ? (
          <ChatView />
        ) : view === 'agent' ? (
          <AgentPanel />
        ) : view === 'files' ? (
          <FilesView />
        ) : view === 'web' ? (
          <WebSearchView />
        ) : view === 'settings' ? (
          <SettingsView
            onShowWelcomeTour={() => {
              // Flag is already cleared by SettingsView; flip the state
              // so the modal reopens without a reload.
              setShowDesktopOnboarding(true);
            }}
          />
        ) : (
          <HabrSearch />
        )}
      </main>
    </div>
  );
}
