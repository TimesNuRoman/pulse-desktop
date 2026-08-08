// SPDX-License-Identifier: Apache-2.0
// Pulse - R248 Raycast-pattern chat view.
//
// R248 replaces R174's persistent left sidebar with a transient
// history popover triggered by a [☰ History] button. The chat
// surface is a single full-width column:
//
//   ┌───────────────────────────────────────────────┐
//   │ Pulse   [ModelSwitcher]            [☰ History]│  topbar
//   │ [Авто] [План] [Ask] [Тесты] [Препью] [Код]     │  routing pills
//   │                                                │
//   │ (chat messages — full-width, max 760px)        │
//   │                                                │
//   │ composer (ChatInput)                           │
//   └───────────────────────────────────────────────┘
//
// The popover lives in HistoryPopover.tsx; this file owns the
// state, the LLM loop, and the layout. All the heavy logic from
// R89 / R160 / R174 / R176 / R186 / R188 / R194 stays the
// same: routing override modal, low_confidence chip, paste-image,
// voice button, agent loop, debounced save, code-block copy.

import { useState, useRef, useEffect, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ToolCall } from '../types';
import { captureScreen, getAutostart, setAutostart, getSTTEngine } from '../api';
import { ChatInput } from './ChatInput';
import { VoiceButton } from './VoiceButton';
import { HistoryPopover } from './HistoryPopover';
import {
  getLLMConfig,
  getProviderName,
  LLMError,
  isVisionAvailable,
  buildMultimodalMessage,
} from '../llm/client';
import { PULSE_SYSTEM_PROMPT_AGENT } from '../llm/prompts';
import {
  runAgentLoop,
  webSearch,
  shouldWebSearch,
  formatSearchContext,
  type ToolCallEvent,
} from '../llm/tools';
import type { ContentPart, LLMMessage } from '../llm/types';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { loadAttachment, type Attachment } from '../files/attachments';
// R89: Smart Engine v3 low_confidence UI consumer.
import type { RoutingMode } from '../llm/route';
import {
  formatChipText,
  formatModalTitle,
  routingModeCategory,
  explainLowConfidence,
  readRoutingOverride,
  writeRoutingOverride,
} from '../llm/routing-ui';
// R174: chat history persistence + popover.
import {
  saveChat,
  loadAllChats,
  loadChat,
  deleteChat,
  renameChat,
  type ChatSummary,
} from '../lib/chatHistory';
// R176: code block "Copy" button.
import { renderChatCode } from './ChatCodeBlock';
// R186: model switcher in chat header. Live hot-swap активной модели
// (список берём из Ollama /api/tags). Не путать с Settings → "Your
// hardware" (R175) — там рекомендации по железу, тут runtime-выбор.
import { ModelSwitcher } from './ModelSwitcher';

const SEED: ChatMessage = {
  id: 'seed-1',
  role: 'assistant',
  content:
    'Привет! Я **Pulse** — компактная панель справа. ' +
    'Чат с LLM, поиск по Хабру, скриншоты, файлы и голосовой ввод — все вкладки сверху. ' +
    'Подробности — в README.',
  ts: Date.now() - 60_000,
};

// R248: routing mode pills in the topbar. Six affordances; "Авто"
// means no override (write null), the other five map onto the
// RoutingMode enum from llm/route.ts. Labels are kept in the
// chat surface (existing Russian UI) — no i18n drift on this
// micro-feature.
const ROUTING_PILLS: { mode: RoutingMode | null; label: string; aria: string }[] = [
  { mode: null, label: 'Авто', aria: 'Авто-роутинг (без override)' },
  { mode: 'QuickAnswer', label: 'Ask', aria: 'Quick Answer — короткий ответ' },
  { mode: 'Reasoning', label: 'План', aria: 'Reasoning — аналитика / планирование' },
  { mode: 'CodeEdit', label: 'Код', aria: 'CodeEdit — генерация / рефактор кода' },
  { mode: 'Vision', label: 'Препью', aria: 'Vision — описание изображений' },
  { mode: 'Default', label: 'Тесты', aria: 'Default — общий фоллбэк' },
];

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toLLMMessages(history: ChatMessage[]): LLMMessage[] {
  // Vision-выбор делается внутри client.ts (по наличию image_url в messages).
  // Здесь решаем: если картинка + vision доступна → шлём content как массив
  // (multimodal). Иначе — fallback на текстовое описание (старое поведение).
  const vision = isVisionAvailable();
  return history
    .filter((m) => !m.streaming || m.content.length > 0) // пустые streaming-плейсхолдеры не шлём
    .filter((m) => !m.toolCall) // tool-call bubble — это UI-only, в LLM не уходит
    .map((m) => {
      // Картинка может быть от скриншота (imageBase64 — PNG без data: префикса)
      // или от прикреплённого файла (attachmentImageDataUrl — полный data: URL).
      const shotDataUrl = m.imageBase64
        ? `data:image/png;base64,${m.imageBase64}`
        : null;
      const attachedDataUrl = m.attachmentImageDataUrl ?? null;
      const imageDataUrl = shotDataUrl ?? attachedDataUrl;
      const imageCaption = m.imageCaption ?? m.attachmentCaption ?? null;

      // Текстовый prefix (caption картинки + текстовый attachment-snippet).
      const prefix = m.imageCaption ? `[Скриншот: ${m.imageCaption}]` : '';
      const fileBlock = m.attachmentTextSnippet
        ? `[Файл: ${m.attachmentCaption ?? m.attachmentPath ?? ''}]\n\`\`\`\n${m.attachmentTextSnippet}\n\`\`\``
        : m.attachmentCaption && !m.attachmentTextSnippet && !imageDataUrl
          ? `[Файл: ${m.attachmentCaption}]`
          : '';

      // === Vision path: отправляем картинку как image_url content block ===
      if (imageDataUrl && vision) {
        // Собираем текст-преамбулу: caption картинки + текст юзера.
        // Если ничего нет — добавим дефолтный вопрос, иначе vision-модель
        // не будет знать, что с картинкой делать.
        const preamble = [prefix, fileBlock].filter(Boolean).join('\n\n');
        const userText = m.content || '';
        const text = [preamble, userText].filter(Boolean).join('\n\n').trim()
          || 'Что на изображении?';
        // image_url + text — OpenAI-style. Ollama /v1/chat/completions
        // принимает как есть и разворачивает в нативный `images: [base64]`.
        return {
          role: m.role,
          content: buildMultimodalMessage(text, imageDataUrl),
        };
      }

      // === Text-only path: fallback или просто текст ===
      // searchContext (если есть) подмешивается ПЕРВЫМ — это user-role
      // инъекция от frontend-эвристики shouldWebSearch. LLM прочтёт и
      // использует заголовки/url'ы из <search_results> в ответе.
      const searchBlock = m.searchContext ?? '';
      const head = [searchBlock, prefix, fileBlock].filter(Boolean).join('\n\n');
      return {
        role: m.role,
        content: head ? `${head}\n\n${m.content}`.trim() : m.content,
      };
    });
}

export function ChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([SEED]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  // R188: voice recording is owned by the <VoiceButton> component; the
  // chat view no longer manages the STT engine directly. `recording` is
  // kept here so the input can switch to a "Recording…" placeholder
  // when the button is held, but it is now driven by a ref callback
  // (set by the button) rather than local state.
  const [recording, setRecording] = useState(false);
  const [sttAvailable, setSttAvailable] = useState(true);
  // R174: chat history state. `currentChatId` is stable across renames,
  // stored to localStorage so refreshes restore the active conversation.
  // Initial value picked on first render via lazy init.
  const [currentChatId, setCurrentChatId] = useState<string>(() => genId());
  const [chatTitle, setChatTitle] = useState<string>('Новый чат');
  // R248: history is a popover, not a sidebar. State is just an open flag.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // Refs that mirror state so debounced save uses the latest values
  // (avoids stale-closure issues inside setTimeout callbacks).
  const messagesRef = useRef<ChatMessage[]>([SEED]);
  const titleRef = useRef<string>('Новый чат');
  const chatIdRef = useRef<string>(currentChatId);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    titleRef.current = chatTitle;
  }, [chatTitle]);
  useEffect(() => {
    chatIdRef.current = currentChatId;
  }, [currentChatId]);
  // Debounced save: 400ms after the last messages change.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // (input lives inside ChatInput now; ref is forwarded to it for STT focus)
  const abortRef = useRef<AbortController | null>(null);
  // Хранит «хвост» истории, который ушёл в LLM — чтобы stop корректно убирал streaming-флаг.
  const assistantIdRef = useRef<string | null>(null);
  // R248: refs for click-outside close on the history popover.
  const historyBtnRef = useRef<HTMLButtonElement | null>(null);
  const historyPanelRef = useRef<HTMLDivElement | null>(null);
  // Прикреплённый к чату файл (через 📎). Один одновременно — для MVP этого хватит.
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  // Развёрнутые картинки в чате (по id сообщения). Дефолт — все свёрнуты (140px).
  const [expandedImages, setExpandedImages] = useState<Set<string>>(() => new Set());
  function toggleImage(id: string) {
    setExpandedImages((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // R89: routing override modal state. Открывается по клику на chip'е
  // "low_confidence" ассистент-сообщения. `messageId` нужно чтобы
  // показать original prompt в modal.
  const [routingModal, setRoutingModal] = useState<{
    messageId: string;
    mode: RoutingMode;
  } | null>(null);
  // R89: последний выбранный override (из localStorage). Применяется как
  // suggested mode в modal — "Last time you picked QuickAnswer".
  const [lastOverride] = useState<RoutingMode | null>(() => readRoutingOverride());
  // R186: активная модель для чата. Инициализируется из getLLMConfig()
  // (env + localStorage override). ModelSwitcher в шапке чата зовёт
  // setCurrentModel при выборе другой модели. Используется в runAgentLoop
  // как modelOverride.
  const [currentModel, setCurrentModel] = useState<string>(() => getLLMConfig().model);

  // Автоскролл к последнему сообщению
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // При монтировании — узнаём текущее состояние автозапуска
  useEffect(() => {
    void (async () => {
      try {
        const v = await getAutostart();
        setAutostartState(v);
      } catch {
        setAutostartState(false);
      }
    })();
  }, []);

  // Cleanup: при размонтировании отменяем стрим
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ─── R174: initial load + history integration ──────────────────────────
  // On mount: load most recent chat if any, else start with SEED only.
  // The "current chat id" we just generated is discarded if we adopt a
  // saved conversation (so the sidebar's "active" highlight matches).
  useEffect(() => {
    const list = loadAllChats();
    setChats(list);
    if (list.length > 0) {
      const top = list[0];
      const loaded = loadChat(top.id);
      if (loaded.length > 0) {
        setCurrentChatId(top.id);
        setChatTitle(top.title);
        setMessages(loaded);
      }
    }
  }, []);

  // R174: title auto-generation. Once the first user message lands, set
  // the title from its text (truncated to 50 chars). Renames from the
  // sidebar take precedence (we skip if title is non-default).
  useEffect(() => {
    if (chatTitle !== 'Новый чат') return;
    const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
    if (!firstUser) return;
    const t = firstUser.content.trim();
    setChatTitle(t.length <= 50 ? t : t.slice(0, 49).trimEnd() + '…');
  }, [messages, chatTitle]);

  // R174: debounced save. 400ms after the last messages change, persist
  // current conversation. Streaming updates collapse into one write.
  useEffect(() => {
    // Skip the very first render — initial state has only SEED, no point
    // saving an empty conversation (loadAllChats filters it anyway).
    const hasUser = messages.some((m) => m.role === 'user');
    if (!hasUser) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveChat(chatIdRef.current, titleRef.current, messagesRef.current);
      setChats(loadAllChats());
    }, 400);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [messages]);

  // R174: beforeunload — flush any pending save synchronously.
  useEffect(() => {
    const onBeforeUnload = () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const hasUser = messagesRef.current.some((m) => m.role === 'user');
      if (hasUser) {
        saveChat(chatIdRef.current, titleRef.current, messagesRef.current);
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // R248: click-outside + Escape closes the history popover. We listen
  // on document (not the panel) so the panel itself can be the target
  // of a click without triggering its own close.
  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        historyPanelRef.current?.contains(t) ||
        historyBtnRef.current?.contains(t)
      ) {
        return;
      }
      setHistoryOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [historyOpen]);

  // R248: when the popover opens, refresh the list so freshly-saved
  // chats show up immediately.
  useEffect(() => {
    if (historyOpen) setChats(loadAllChats());
  }, [historyOpen]);

  // R174: handlers wired to the popover.
  function onNewChat() {
    // Persist the current conversation first (if it has any user content).
    const hasUser = messagesRef.current.some((m) => m.role === 'user');
    if (hasUser) {
      saveChat(chatIdRef.current, titleRef.current, messagesRef.current);
    }
    const newId = genId();
    setCurrentChatId(newId);
    setChatTitle('Новый чат');
    setMessages([SEED]);
    setChats(loadAllChats());
    setHistoryOpen(false); // R248: popover closes after a new chat starts
  }

  function onSelectChat(id: string) {
    if (id === currentChatId) {
      setHistoryOpen(false);
      return;
    }
    // Persist current before switching.
    const hasUser = messagesRef.current.some((m) => m.role === 'user');
    if (hasUser) {
      saveChat(chatIdRef.current, titleRef.current, messagesRef.current);
    }
    const loaded = loadChat(id);
    if (loaded.length === 0) return;
    const summary = chats.find((c) => c.id === id);
    setCurrentChatId(id);
    setChatTitle(summary?.title || 'Чат');
    setMessages(loaded);
    setChats(loadAllChats());
    setHistoryOpen(false); // R248: popover closes on pick
  }

  function onDeleteChat(id: string) {
    deleteChat(id);
    if (id === currentChatId) {
      const newId = genId();
      setCurrentChatId(newId);
      setChatTitle('Новый чат');
      setMessages([SEED]);
    }
    setChats(loadAllChats());
  }

  function onRenameChat(id: string, newTitle: string) {
    renameChat(id, newTitle);
    if (id === currentChatId) setChatTitle(newTitle);
    setChats(loadAllChats());
  }

  // ── core submit (выделено, чтобы и onSubmit, и onDescribe использовали одну логику) ──
  interface SubmitOpts {
    /** Текст юзера (может быть пустым если есть картинка/attachment). */
    text: string;
    /** Опц. attachment (📎). */
    attachment: Attachment | null;
    /** Опц. картинка-скриншот (используется onDescribe и /describe). */
    screenshot?: { base64: string; caption: string };
  }

  /**
   * Запустить один раунд: добавить userMsg, поставить placeholder ассистента,
   * прогнать agent loop, обработать финал. Smart Engine (tool calls, JSON-mode,
   * abort, error-баннер) — всё сохраняем 1:1 как было в onSubmit.
   */
  async function runSubmitCore(opts: SubmitOpts) {
    const { text, attachment: att, screenshot } = opts;
    setLlmError(null);
    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: text,
      ts: Date.now(),
      ...(screenshot
        ? {
            imageBase64: screenshot.base64,
            imageCaption: screenshot.caption,
          }
        : {}),
      ...(att
        ? {
            attachmentCaption: att.caption,
            attachmentImageDataUrl: att.imageDataUrl ?? undefined,
            attachmentTextSnippet: att.textSnippet ?? undefined,
            attachmentPath: att.info.path,
          }
        : {}),
    };

    // Pulse v5 — web_search по эвристике shouldWebSearch. Делаем синхронно
    // ДО `runAgentLoop` (агент уже стартанёт с готовым <search_results>
    // блоком в контексте). На ошибку/timeout — тихо молчим: chat не ломаем.
    // Не дёргаем для screenshot-only сообщений и /describe.
    if (text && !screenshot && shouldWebSearch(text)) {
      try {
        const r = await webSearch(text, 5);
        userMsg.searchContext = formatSearchContext(text, r);
        userMsg.searchQuery = text;
      } catch {
        // Тихо. LLM ответит и без контекста, просто без блока "🔍 Источники:".
      }
    }
    // Плейсхолдер под ассистента (стриминг)
    const assistantId = genId();
    assistantIdRef.current = assistantId;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
      ts: Date.now() + 1,
    };
    const history = [...messages, userMsg];
    setMessages([...history, assistantMsg]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // === Pulse v5: agent loop ===
    // runAgentLoop дёргает LLM, если LLM вернула tool-call — выполняет его и шлёт
    // результат обратно. Возвращает финальный текст + лог tool-вызовов.
    try {
      const result = await runAgentLoop({
        messages: [PULSE_SYSTEM_PROMPT_AGENT, ...toLLMMessages(history)],
        signal: controller.signal,
        // R186: live hot-swap модели. Если юзер сменил модель через
        // ModelSwitcher — этот раунд пойдёт в новую модель. История
        // сохраняется (мы не очищаем messages), так что контекст остаётся.
        model: currentModel,
        callbacks: {
          onTextDelta: (delta) => {
            setMessages((cur) =>
              cur.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + delta } : m,
              ),
            );
          },
          onToolStart: (ev) => {
            setMessages((cur) => [
              ...cur,
              {
                id: genId(),
                role: 'assistant',
                content: '',
                ts: Date.now() + 2,
                toolCall: {
                  tool: ev.tool,
                  args: ev.args,
                  result: null,
                  error: null,
                  pending: true,
                },
              },
            ]);
          },
          onToolEnd: (ev) => {
            setMessages((cur) => {
              for (let i = cur.length - 1; i >= 0; i--) {
                const m = cur[i];
                if (m.role === 'assistant' && m.toolCall?.pending) {
                  const next: ChatMessage = {
                    ...m,
                    toolCall: {
                      tool: ev.tool,
                      args: ev.args,
                      result: ev.result,
                      error: ev.error ?? null,
                      pending: false,
                    },
                  };
                  const copy = cur.slice();
                  copy[i] = next;
                  return copy;
                }
              }
              return cur;
            });
          },
        },
        maxSteps: 5,
      });

      setMessages((cur) =>
        cur.map((m) => {
          if (m.id !== assistantId) return m;
          const out: ChatMessage = { ...m, streaming: false };
          if (result.finishReason === 'cancelled') {
            out.content = (m.content + '\n\n_⏹ остановлено_').trim();
          } else if (result.finishReason === 'length') {
            out.content = m.content + '\n\n_…ответ обрезан (лимит токенов)_';
          } else if (result.finishReason === 'max-steps') {
            out.content =
              (m.content || '⚠ Дошёл до лимита tool-шагов.') +
              `\n\n_${result.error ?? ''}_`.trim();
          } else if (result.finishReason === 'error' && result.error) {
            out.content = `⚠ ${result.error}`;
          } else if (!m.content && result.toolCalls.length === 0) {
            out.content = '_(пустой ответ от LLM)_';
          }
          // R89: прикрепляем routing decision к сообщению. ChatView использует
          // `m.routing?.lowConfidence` чтобы решить, рисовать ли chip.
          // Только если есть routing (Tauri) и не cancelled/error (там чип
          // будет шумом).
          if (
            result.routing &&
            result.finishReason !== 'cancelled' &&
            result.finishReason !== 'error'
          ) {
            out.routing = result.routing;
            out.routingMode = result.routingMode;
          }
          return out;
        }),
      );
    } catch (e) {
      const msg = e instanceof LLMError ? e.message : `Ошибка: ${(e as Error).message}`;
      setLlmError(msg);
      setMessages((cur) =>
        cur.map((m) =>
          m.id === assistantId
            ? { ...m, streaming: false, content: `⚠ ${msg}` }
            : m,
        ),
      );
    } finally {
      setBusy(false);
      abortRef.current = null;
      assistantIdRef.current = null;
    }
  }

  // R174: <form> wrapper's onSubmit. Внутри ChatInput рендерит свой
  // <form class="chat__inputrow">, поэтому внешняя обёртка ловит submit
  // через всплытие (Enter в input) либо через явный submit на самой
  // форме (тесты шлют synthetic event напрямую). Передаём draft в
  // onSubmitText, который уже знает про /describe, attachment и busy-guard.
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void onSubmitText(draft);
  }

  // R160: разнесено — ChatInput дёргает onSubmitText(text) для текстового
  // submit и onVisionResponse(...) для paste-image submit. Оба пути
  // сходятся на runSubmitCore (через разные входы). Slash-команда
  // /describe по-прежнему живёт здесь — она снимает скриншот и гонит
  // его в vision-LLM, минуя paste-image preview.
  async function onSubmitText(text: string) {
    // Slash-команда /describe: снять скриншот + отправить в vision-модель.
    // Pulse v5.1 — vision quick action. Делаем ДО проверки пустого текста,
    // чтобы юзер мог просто напечатать "/describe" без Enter.
    if (text === '/describe' || text.startsWith('/describe ')) {
      const rest = text.replace(/^\/describe\s*/, '').trim();
      setDraft('');
      await onDescribe(rest || undefined);
      return;
    }
    // Пустой текст + нет файла — игнорим
    if ((!text && !attachment) || busy) return;

    const attForPrompt = attachment;
    setAttachment(null);
    setDraft('');
    await runSubmitCore({ text, attachment: attForPrompt });
  }

  /**
   * R160: paste-image submit. ChatInput уже дёрнул vision API и получил
   * ответ; наша задача — добавить user-bubble (с картинкой) и assistant-
   * bubble (с текстом) в историю чата. Идём через runSubmitCore, чтобы
   * маршрутизация / smart-engine / agent-loop работали идентично обычному
   * submit (vision-tool fallback и т.д.). Передаём картинку как
   * attachmentImageDataUrl — это уже поддерживается toLLMMessages и
   * buildMultimodalMessage.
   */
  async function onVisionResponse(resp: {
    userText: string;
    imageDataUrl: string;
    assistantText: string;
  }) {
    if (busy) return;
    setLlmError(null);
    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: resp.userText,
      ts: Date.now(),
      attachmentImageDataUrl: resp.imageDataUrl,
      attachmentCaption: 'Изображение из буфера',
    };
    // Простой flow: не дёргаем agent loop — vision уже отработала. Просто
    // добавляем два bubble в историю. Если нужен будет tool-call / search
    // поверх картинки — это уже R161+.
    const assistantMsg: ChatMessage = {
      id: genId(),
      role: 'assistant',
      content: resp.assistantText,
      ts: Date.now() + 1,
    };
    setMessages((cur) => [...cur, userMsg, assistantMsg]);
  }

  function onStop() {
    abortRef.current?.abort();
  }

  async function onCapture() {
    if (screenshotBusy) return;
    setScreenshotBusy(true);
    setLlmError(null);
    try {
      const shot = await captureScreen();
      const userMsg: ChatMessage = {
        id: genId(),
        role: 'user',
        content: '',
        imageBase64: shot.base64,
        imageCaption: `${Math.round(shot.bytes / 1024)} КБ · сохранено в ${shot.path}`,
        ts: Date.now(),
      };
      setMessages((cur) => [...cur, userMsg]);
    } catch (e) {
      setLlmError(`Скриншот: ${(e as Error).message}`);
    } finally {
      setScreenshotBusy(false);
    }
  }

  /**
   * Pulse v5.1 — vision quick action: снять скриншот и сразу отправить его
   * в vision-модель с дефолтным промптом «Что на экране?». Если передан
   * `customPrompt` (например, остаток после /describe) — используем его.
   * Если vision-модель не сконфигурирована — клиент вернёт понятную ошибку,
   * картинка в UI останется как обычное сообщение (юзер сможет сам дописать
   * текст и нажать Send).
   */
  async function onDescribe(customPrompt?: string) {
    if (busy || screenshotBusy) return;
    setScreenshotBusy(true);
    setLlmError(null);
    try {
      const shot = await captureScreen();
      const prompt =
        customPrompt && customPrompt.trim()
          ? customPrompt.trim()
          : 'Опиши, что сейчас на экране. Если есть текст или код — распознай ключевое.';
      await runSubmitCore({
        text: prompt,
        attachment: null,
        screenshot: {
          base64: shot.base64,
          caption: `Скриншот основного монитора · ${Math.round(shot.bytes / 1024)} КБ · ${shot.path}`,
        },
      });
    } catch (e) {
      setLlmError(`Vision: ${(e as Error).message}`);
    } finally {
      setScreenshotBusy(false);
    }
  }

  /**
   * Открыть системный диалог выбора файла, прочитать его и показать превью.
   * Один файл одновременно — для MVP этого хватит; повторный клик заменит.
   */
  async function onAttach() {
    if (attachBusy) return;
    setAttachBusy(true);
    setLlmError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        title: 'Прикрепить файл к чату',
        // Пустые filters = любой файл; пользователь сам решит.
      });
      // Tauri v2: `open` с multiple:false возвращает string | null
      if (!picked || typeof picked !== 'string') return;
      const att = await loadAttachment(picked);
      setAttachment(att);
    } catch (e) {
      setLlmError(`Файл: ${(e as Error).message}`);
    } finally {
      setAttachBusy(false);
    }
  }

  function onDetach() {
    setAttachment(null);
  }

  async function onToggleAutostart() {
    if (autostart === null) return;
    const next = !autostart;
    try {
      const actual = await setAutostart(next);
      setAutostartState(actual);
    } catch (e) {
      setLlmError(`Автозапуск: ${(e as Error).message}`);
    }
  }

  // R248: pill click writes the new override (or clears it for "Авто").
  function onPickPill(mode: RoutingMode | null) {
    writeRoutingOverride(mode);
  }

  const cfg = getLLMConfig();
  const provider = getProviderName();
  const noKey = !cfg.hasKey;
  // R248: which pill is "active" right now?
  const activePill: RoutingMode | null = lastOverride; // lastOverride seeded from LS once; treat the initial pick as binding for the rest of the session

  return (
    <div className="raycast-chat">
      {/* R248: topbar. Logo + model switcher + history button. */}
      <header className="raycast-topbar" data-testid="raycast-topbar">
        <div className="raycast-topbar__brand" data-testid="raycast-brand">
          <span className="raycast-topbar__brand-dot" aria-hidden />
          <span className="raycast-topbar__brand-text">Pulse</span>
        </div>
        <div className="raycast-topbar__model">
          <ModelSwitcher
            currentModel={currentModel}
            onSwitch={setCurrentModel}
          />
          {isVisionAvailable() && (
            <span
              className="raycast-topbar__vision"
              title={`Vision-модель: ${cfg.visionModel}`}
              aria-label={`Vision-модель: ${cfg.visionModel}`}
            >
              <span className="raycast-topbar__vision-dot" aria-hidden />
              vision
            </span>
          )}
        </div>
        <button
          ref={historyBtnRef}
          type="button"
          className="raycast-topbar__history"
          onClick={() => setHistoryOpen((cur) => !cur)}
          aria-haspopup="dialog"
          aria-expanded={historyOpen}
          aria-label="История чатов"
          title="История чатов"
          data-testid="raycast-history-btn"
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
              d="M2 3.5h10M2 7h10M2 10.5h7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span>History</span>
        </button>
      </header>

      {/* R248: routing mode pills. Mirrors ROUTING_PILLS above; the
          active one is the currently persisted override. */}
      <nav
        className="raycast-pills"
        role="tablist"
        aria-label="Routing mode"
        data-testid="raycast-pills"
      >
        {ROUTING_PILLS.map((p) => {
          const isActive = p.mode === activePill;
          return (
            <button
              key={p.label}
              type="button"
              role="tab"
              aria-pressed={isActive}
              aria-label={p.aria}
              className={`raycast-pill ${isActive ? 'is-active' : ''}`}
              onClick={() => onPickPill(p.mode)}
              data-testid="raycast-pill"
              data-pill-label={p.label}
            >
              {p.label}
            </button>
          );
        })}
      </nav>

      {/* R248: full-width chat list (centered, max 760px). */}
      <main className="raycast-messages" ref={listRef} data-testid="chat-list">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`chat__bubble chat__bubble--${m.role}${
              m.toolCall ? ' chat__bubble--tool' : ''
            }${
              m.routing?.lowConfidence
                ? ' chat__bubble--low-confidence'
                : ''
            }`}
            data-role={m.role}
          >
            <div className="chat__author">
              {m.role === 'user' ? 'ты' : m.toolCall ? 'pulse · action' : 'pulse'}
              {m.searchQuery && (
                <span
                  className="chat__searchhint"
                  title={`Запрос: ${m.searchQuery}`}
                >
                  search
                </span>
              )}
            </div>
            {/* R89: low_confidence chip — показывается только если движок
                не был уверен в routing'е. Клик открывает modal с деталями
                и override-опциями. Стили — Tokyo Night (см. styles.css). */}
            {m.routing?.lowConfidence && m.routingMode && (
              <button
                type="button"
                className="chat__chip chat__chip--low"
                onClick={() =>
                  setRoutingModal({ messageId: m.id, mode: m.routingMode! })
                }
                title="Smart Engine не был уверен в выборе модели. Клик — детали."
                data-testid="low-confidence-chip"
              >
                <span className="chat__chip-dot" aria-hidden />
                <span className="chat__chip-text">
                  {formatChipText(m.routingMode)}
                </span>
              </button>
            )}
            {/* Tool-call bubble: показываем "что Pulse делает" */}
            {m.toolCall && (
              <div className="chat__toolcall" data-pending={m.toolCall.pending ? '1' : '0'}>
                <div className="chat__toolcall-head">
                  <span className="chat__toolcall-ico" aria-hidden>
                    {m.toolCall.pending ? '…' : m.toolCall.error ? '!' : 'ok'}
                  </span>
                  <span className="chat__toolcall-name">
                    {m.toolCall.tool}
                  </span>
                  {Object.keys(m.toolCall.args).length > 0 && (
                    <span className="chat__toolcall-args">
                      ({formatArgs(m.toolCall.args)})
                    </span>
                  )}
                </div>
                {!m.toolCall.pending && m.toolCall.result && (
                  <pre className="chat__toolcall-result">
                    {truncate(m.toolCall.result, 1200)}
                  </pre>
                )}
                {m.toolCall.error && (
                  <div className="chat__toolcall-err">{m.toolCall.error}</div>
                )}
              </div>
            )}
            {m.imageBase64 && (
              <div className="chat__imagewrap">
                <img
                  className="chat__image"
                  src={`data:image/png;base64,${m.imageBase64}`}
                  alt="screenshot"
                  data-expanded={expandedImages.has(m.id) ? '1' : '0'}
                  onClick={() => toggleImage(m.id)}
                  title={expandedImages.has(m.id) ? 'Свернуть' : 'Развернуть'}
                />
                {m.imageCaption && (
                  <div className="chat__imagecap">{m.imageCaption}</div>
                )}
              </div>
            )}
            {m.attachmentImageDataUrl && (
              <div className="chat__imagewrap">
                <img
                  className="chat__image"
                  src={m.attachmentImageDataUrl}
                  alt={m.attachmentCaption ?? 'attachment'}
                  data-expanded={expandedImages.has(m.id) ? '1' : '0'}
                  onClick={() => toggleImage(m.id)}
                  title={expandedImages.has(m.id) ? 'Свернуть' : 'Развернуть'}
                />
                {m.attachmentCaption && (
                  <div className="chat__imagecap">{m.attachmentCaption}</div>
                )}
              </div>
            )}
            {m.attachmentTextSnippet && (
              <div className="chat__attachsnippet">
                <div className="chat__imagecap">{m.attachmentCaption}</div>
                <pre><code>{m.attachmentTextSnippet}</code></pre>
              </div>
            )}
            {!m.imageBase64 && !m.attachmentImageDataUrl && !m.attachmentTextSnippet && m.attachmentCaption && (
              <div className="chat__attachmeta">file · {m.attachmentCaption}</div>
            )}
            {m.content && (
              <div className="chat__content">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{ code: renderChatCode }}
                >
                  {m.content}
                </ReactMarkdown>
                {m.streaming && <span className="chat__cursor">▍</span>}
              </div>
            )}
          </div>
        ))}
      </main>

      {noKey && (
        <div className="chat__warn">
          API-ключ не задан — LLM не работает. Создай <code>.env</code> в корне
          проекта (см. <code>.env.example</code>), укажи <code>VITE_LLM_API_KEY</code>,
          затем перезапусти dev/build.
        </div>
      )}
      {llmError && <div className="chat__warn">{llmError}</div>}

      {attachment && (
        <div className="chat__attach" data-kind={attachment.kind}>
          <div className="chat__attachhead">
            <span className="chat__attachcap">{attachment.caption}</span>
            <button
              type="button"
              className="chat__attachclose"
              onClick={onDetach}
              title="Открепить"
              aria-label="Открепить файл"
            >
              ×
            </button>
          </div>
          {attachment.kind === 'image' && attachment.imageDataUrl && (
            <img
              className="chat__image"
              src={attachment.imageDataUrl}
              alt={attachment.info.name}
            />
          )}
          {attachment.kind === 'text' && attachment.textSnippet && (
            <pre className="chat__attachpre"><code>{attachment.textSnippet}</code></pre>
          )}
          {(attachment.kind === 'video') && (
            <div className="chat__attachmeta">Видео — превью недоступно (v4 MVP)</div>
          )}
          {(attachment.kind === 'audio') && (
            <div className="chat__attachmeta">Аудио — превью недоступно (v4 MVP)</div>
          )}
          {(attachment.kind === 'binary' || attachment.kind === 'pdf') && !attachment.textSnippet && (
            <div className="chat__attachmeta">
              Бинарный файл — будет отправлен как метаданные (имя, размер)
            </div>
          )}
        </div>
      )}

      {/* R248: composer. R174's <form> wrapper is kept for compatibility
          with bubbled submit from ChatInput's inner form. R176's code
          block Copy button is still wired via `components={{ code: renderChatCode }}`. */}
      <form className="raycast-composer" onSubmit={onSubmit}>
        <div className="raycast-composer__inner">
          <ChatInput
            value={draft}
            onChange={setDraft}
            onSubmitText={onSubmitText}
            onVisionResponse={onVisionResponse}
            onError={(msg) => setLlmError(msg)}
            inputRef={inputRef}
            busy={busy || recording}
            provider={provider}
            model={cfg.model}
            visionAvailable={isVisionAvailable()}
            visionModel={cfg.visionModel}
            visionBaseUrl={cfg.baseUrl}
            placeholder={
              recording
                ? 'Говорите…'
                : noKey
                  ? 'API-ключ не задан…'
                  : attachment
                    ? `Комментарий к ${attachment.info.name}…`
                    : 'Спросите про код проекта…'
            }
            leftToolbar={
              <>
                <button
                  type="button"
                  className="chat__iconbtn"
                  title="Скриншот основного монитора"
                  onClick={() => void onCapture()}
                  disabled={screenshotBusy}
                >
                  {screenshotBusy ? '…' : 'shot'}
                </button>
                <button
                  type="button"
                  className="chat__iconbtn"
                  title={attachment ? `Прикреплён: ${attachment.info.name} (повторный клик — заменить)` : 'Прикрепить файл'}
                  onClick={() => void onAttach()}
                  disabled={attachBusy}
                >
                  {attachBusy ? '…' : 'attach'}
                </button>
                <button
                  type="button"
                  className="chat__iconbtn chat__iconbtn--vision"
                  title={
                    isVisionAvailable()
                      ? 'Снять скриншот и описать (vision-LLM)'
                      : 'Vision-модель не настроена (см. Settings)'
                  }
                  onClick={() => void onDescribe()}
                  disabled={screenshotBusy || busy || !isVisionAvailable()}
                >
                  {screenshotBusy ? '…' : 'vision'}
                </button>
                <VoiceButton
                  onTranscript={(text) => {
                    setDraft((d) => (d ? `${d} ${text}` : text));
                    inputRef.current?.focus();
                  }}
                  onRecordingChange={setRecording}
                  disabled={busy}
                />
              </>
            }
            rightToolbar={
              <>
                {isVisionAvailable() && (
                  <span
                    className="chat__vision"
                    title={`Vision-модель: ${cfg.visionModel}`}
                    aria-label={`Vision-модель: ${cfg.visionModel}`}
                  >
                    <span className="chat__vision-dot" aria-hidden />
                    vision
                  </span>
                )}
                <button
                  type="button"
                  className="chat__iconbtn chat__iconbtn--autostart"
                  title={
                    autostart === null
                      ? 'Автозапуск…'
                      : autostart
                        ? 'Автозапуск вкл (клик — выкл)'
                        : 'Автозапуск выкл (клик — вкл)'
                  }
                  onClick={() => void onToggleAutostart()}
                  disabled={autostart === null}
                  data-on={autostart ? '1' : '0'}
                >
                  autostart
                </button>
                {busy && (
                  <button
                    type="button"
                    className="chat__send chat__send--stop"
                    onClick={onStop}
                    title="Остановить генерацию"
                    data-testid="chat-stop"
                  >
                    stop
                  </button>
                )}
              </>
            }
          />
        </div>
      </form>

      {/* R89: routing override modal. Показывается по клику на chip'е
          low_confidence. Позволяет юзеру выбрать preferred mode для
          следующих промптов (saved to localStorage). Не реально переключает
          routing — это scope R90+ (нужно пробрасывать modelOverride в
          streamChat и engine_decide). R89 фиксирует только preference. */}
      {routingModal && (
        <RoutingOverrideModal
          mode={routingModal.mode}
          // Показываем original prompt — ищем user-message прямо перед
          // assistant-сообщением с chip'ом. Fallback на '...' если не нашли.
          prompt={(() => {
            const idx = messages.findIndex((m) => m.id === routingModal.messageId);
            for (let i = idx - 1; i >= 0; i--) {
              if (messages[i].role === 'user') return messages[i].content;
            }
            return '...';
          })()}
          // Confidence signals из routing decision
          signals={(() => {
            const m = messages.find((mm) => mm.id === routingModal.messageId);
            const r = m?.routing;
            return r
              ? {
                  codeParseSignal: r.codeParseSignal,
                  fired: r.fired,
                  score: r.score,
                  threshold: r.threshold,
                }
              : null;
          })()}
          lastOverride={lastOverride}
          onClose={() => setRoutingModal(null)}
          onPickOverride={(mode) => {
            writeRoutingOverride(mode);
            setRoutingModal(null);
          }}
        />
      )}

      {/* R248: history popover. Anchored to the history button. */}
      {historyOpen && (
        <div
          ref={historyPanelRef}
          className="raycast-history"
          data-testid="raycast-history-panel"
        >
          <HistoryPopover
            chats={chats}
            currentId={currentChatId}
            onSelect={onSelectChat}
            onNewChat={onNewChat}
            onDelete={onDeleteChat}
            onRename={onRenameChat}
            onClose={() => setHistoryOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

// ─── R89: RoutingOverrideModal ───────────────────────────────────────────

interface RoutingOverrideModalProps {
  mode: RoutingMode;
  prompt: string;
  signals: {
    codeParseSignal: boolean;
    fired: string[];
    score: number;
    threshold: number;
  } | null;
  lastOverride: RoutingMode | null;
  onClose: () => void;
  onPickOverride: (mode: RoutingMode) => void;
}

/**
 * Modal для low_confidence override'а. Показывает:
 *   * Заголовок "Why {mode}?"
 *   * Original prompt (truncated до 280 chars)
 *   * Routing decision (preferredModel, score/threshold)
 *   * Объяснение low_confidence причины
 *   * "Use {mode} next time" / "Use QuickAnswer next time" / "Dismiss" кнопки
 *
 * Не реально меняет routing (это R90+). R89: только preference persistence.
 */
function RoutingOverrideModal(props: RoutingOverrideModalProps) {
  const { mode, prompt, signals, lastOverride, onClose, onPickOverride } = props;
  // Список альтернативных mode'ов для override (все 5, кроме текущего).
  const allModes: RoutingMode[] = ['CodeEdit', 'Vision', 'QuickAnswer', 'Reasoning', 'Default'];
  const alternatives = allModes.filter((m) => m !== mode);
  return (
    <div
      className="chat__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="routing-modal-title"
      onClick={onClose}
      data-testid="routing-modal"
    >
      <div
        className="chat__modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chat__modal-head">
          <h3 id="routing-modal-title" className="chat__modal-title">
            {formatModalTitle(mode)}
          </h3>
          <button
            type="button"
            className="chat__modal-close"
            onClick={onClose}
            aria-label="Закрыть"
            title="Закрыть"
          >
            ×
          </button>
        </div>
        <div className="chat__modal-body">
          <div className="chat__modal-section">
            <div className="chat__modal-label">Original prompt</div>
            <div className="chat__modal-prompt">
              {truncate(prompt, 280)}
            </div>
          </div>
          <div className="chat__modal-section">
            <div className="chat__modal-label">Routed to</div>
            <div className="chat__modal-mode">
              <span className="chat__chip-dot" aria-hidden />
              {mode}
              <span className="chat__modal-mode-cat">
                — {routingModeCategory(mode)}
              </span>
            </div>
          </div>
          <div className="chat__modal-section">
            <div className="chat__modal-label">Confidence</div>
            <div className="chat__modal-confidence">
              {signals ? (
                <>
                  <div className="chat__modal-confline">
                    {explainLowConfidence(signals)}
                  </div>
                  <div className="chat__modal-confmeta">
                    Score {signals.score}/{signals.threshold}
                    {signals.fired.length > 0 && ` · ${signals.fired.join(', ')}`}
                  </div>
                </>
              ) : (
                <div className="chat__modal-confline">No routing data available.</div>
              )}
            </div>
          </div>
          {lastOverride && lastOverride !== mode && (
            <div className="chat__modal-section">
              <div className="chat__modal-label">Last override</div>
              <div className="chat__modal-last-override">
                Вы выбрали <b>{lastOverride}</b> в прошлый раз. Сохранить текущий ({mode}) как новый override?
              </div>
            </div>
          )}
        </div>
        <div className="chat__modal-foot">
          <button
            type="button"
            className="chat__modalbtn chat__modalbtn--ghost"
            onClick={onClose}
          >
            Dismiss
          </button>
          {alternatives.map((alt) => (
            <button
              key={alt}
              type="button"
              className={`chat__modalbtn chat__modalbtn--pick${
                lastOverride === alt ? ' is-prev' : ''
              }`}
              onClick={() => onPickOverride(alt)}
              data-testid={`pick-${alt}`}
              title={
                lastOverride === alt
                  ? `Use ${alt} next time (also your previous pick)`
                  : `Use ${alt} next time`
              }
            >
              {lastOverride === alt ? `Use ${alt} (last pick)` : `Use ${alt}`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── helpers для tool-call bubble ─────────────────────────────────────────

/** Компактный вид аргументов tool-call: "query: 'witcher 3'" */
function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}: ${truncate(s, 40)}`);
  }
  return parts.join(', ');
}

/** Усечение длинной строки с многоточием. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
