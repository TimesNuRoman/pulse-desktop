# Pulse — voice-first AI side panel

Компактная Tauri-панель справа на экране: чат с LLM (стриминг) + поиск по Хабру + 📸-скриншот.
Сворачивается в трей, автозапуск ОС настраивается из UI.
Под будущее заложены модули wake-word / STT / OCR (сейчас — заглушки-интерфейсы).

## Стек

- **Backend:** Tauri v2 (Rust), tray-icon, global-shortcut, autostart
- **Frontend:** React 18 + TypeScript + Vite
- **LLM:** OpenAI-совместимый streaming endpoint (по умолчанию локальный **LM Studio**, `gemma2:2b`, `http://127.0.0.1:1234/v1`)
- **Markdown:** react-markdown + remark-gfm
- **Habr-поиск:** локальный Next.js-сервис `../habr-search` (порт 3000)

## Структура

```
pulse-desktop/
├── src-tauri/                 # Rust-бэк Tauri
│   ├── src/lib.rs             # команды + tray + window positioning
│   ├── tauri.conf.json        # окно, трей, бандл
│   └── capabilities/default.json
├── web/                       # фронт
│   ├── src/
│   │   ├── App.tsx            # вкладки Чат / Habr, drag-region, кнопка "свернуть"
│   │   ├── api.ts             # Tauri-инвоки (search_habr, capture_screen, autostart, …)
│   │   ├── types.ts
│   │   ├── llm/               # LLM-клиент (streaming, OpenAI-совместимый)
│   │   │   ├── client.ts      # fetch + SSE + AbortController
│   │   │   ├── types.ts
│   │   │   └── prompts.ts
│   │   ├── components/
│   │   │   ├── ChatView.tsx   # чат + LLM стрим + 📸 + автозапуск
│   │   │   └── HabrSearch.tsx
│   │   ├── voice/             # ЗАГЛУШКИ под будущее
│   │   │   ├── wakeword.ts    # Porcupine / Vosk-KWS
│   │   │   └── stt.ts         # Vosk / Whisper.cpp
│   │   ├── screen/
│   │   │   └── ocr.ts         # Tesseract / PaddleOCR / vision API
│   │   ├── styles.css
│   │   └── main.tsx
│   └── index.html
├── package.json
├── .env.example               # шаблон для VITE_LLM_API_KEY и т.п.
└── vite.config.ts
```

## Как запустить

### 1. (опционально) Поднять habr-search — нужен для вкладки «Habr»

```powershell
cd C:\Users\1\.minimax-agent\projects\habr-search
npm install        # один раз
npm run dev        # слушает http://127.0.0.1:3000
```

Без него вкладка «Habr» покажет ошибку `habr-search offline`. Чат и скриншот работают и без него.
Если хост/порт другие — задай `HABR_SEARCH_URL=http://host:port` в `.env`.

### 2. Настроить LLM (нужен для чата)

Pulse по умолчанию ходит в локальный **LM Studio** (`gemma2:2b` на `http://127.0.0.1:1234/v1`).
Скопируй шаблон окружения:

```powershell
# в корне pulse-desktop
Copy-Item .env.example .env
```

`VITE_LLM_API_KEY=lm-studio` по дефолту — LM Studio ключ не проверяет, прокатит любая строка.
Если хочешь OpenAI / OpenRouter / другой OpenAI-совместимый провайдер — поменяй
`VITE_LLM_BASE_URL`, `VITE_LLM_MODEL` и `VITE_LLM_API_KEY` (см. `.env.example`).
Без ключа (и без запущенного LM Studio) чат покажет баннер «LLM недоступен» и кнопка
«Отправить» будет задизейблена.

Установка LM Studio: <https://lmstudio.ai/> → Download → обычный `.exe`-инсталлер.
Альтернативно: `winget install LMStudio.LMStudio` или портативный zip (без установки).
CLI `lms.exe` после установки лежит в `C:\Users\1\.lmstudio\bin\lms.exe`.

### 3. Запустить Pulse в dev-режиме (с горячей перезагрузкой)

```powershell
cd C:\Users\1\.minimax-agent\projects\pulse-desktop
npm install        # один раз
npm run tauri dev
```

Откроется окно 380px, прижатое к правому краю экрана, на всю высоту.

### 4. Собрать релиз

```powershell
npm run tauri build
```

Артефакты — в `src-tauri/target/release/bundle/`. `VITE_LLM_API_KEY` подставляется
в бандл на этапе сборки, поэтому для релиза его тоже нужно задать (или вынести в
отдельный .env на машине сборки).

## LLM (Pulse использует локальный LM Studio)

### Установка

1. Скачай LM Studio: <https://lmstudio.ai/> → Download (`.exe`-инсталлер) или
   `winget install LMStudio.LMStudio`. Можно и портативный zip — без установки.
2. Скачай модель `gemma2:2b`:
   - **Через GUI:** открой LM Studio → Search → `gemma2` → `2b` → Download.
   - **Через CLI:** `lms get gemma2:2b` (≈1.7 ГБ; один раз).
3. Запусти локальный сервер:
   - **Через GUI:** вкладка **Developer** → **Local Server** → выбери модель
     `gemma2:2b` → порт `1234` → Start Server.
   - **Через CLI:** `lms server start --port 1234` (по дефолту слушает
     `http://127.0.0.1:1234/v1`). Флаг `--cors` разрешает кросс-доменные
     запросы из браузера.
4. Проверь что всё ок: `curl http://127.0.0.1:1234/v1/models` — должен вернуть
   JSON со списком загруженных моделей.

### Конфиг Pulse

Скопируй `.env.example` в `.env` или выставь переменные окружения. По умолчанию
там уже стоит LM Studio:

```bash
VITE_LLM_BASE_URL=http://127.0.0.1:1234/v1
VITE_LLM_API_KEY=lm-studio
VITE_LLM_MODEL=gemma2:2b
```

Если LM Studio не запущен или модель не загружена — Pulse при попытке отправить
сообщение покажет ошибку «LLM недоступен» (UI не падает).

### Хочешь другого провайдера?

LM Studio отдаёт OpenAI-совместимый `/v1/chat/completions`, так что любой
OpenAI-compatible endpoint подойдёт — поменяй `VITE_LLM_BASE_URL`,
`VITE_LLM_MODEL` и при необходимости `VITE_LLM_API_KEY`.

## Что работает (MVP)

- ✅ **Side panel:** 380×full-height, transparent, decorations=false, alwaysOnTop
- ✅ **Позиция:** при первом запуске прижимается к правому краю; при перетаскивании сохраняется в `%APPDATA%\app.pulse.local\window-state.json` (с debounce 200мс) и восстанавливается
- ✅ **Перетаскивание:** за header (атрибут `data-tauri-drag-region`)
- ✅ **Трей:** контекстное меню «Показать Pulse / Скрыть в трей / Настройки / Выход» + click-to-toggle
- ✅ **Крестик = свернуть в трей** (приложение продолжает работать)
- ✅ **Глобальный хоткей:** `Ctrl+Shift+Space` — toggle панели
- ✅ **Чат с LLM:** стриминг ответов (SSE), кнопка «Стоп» прерывает генерацию, история передаётся в LLM как контекст
- ✅ **📸 Скриншот основного монитора:** кнопка 📸 в форме чата → нативный снимок через `xcap`, превью в чате, файл во временной папке ОС
- ✅ **Автозапуск ОС:** кнопка ⚙ в форме чата → toggle (через `tauri-plugin-autostart`, с флагом `--minimized`)
- ✅ **Вкладка «Habr»:** проксирует на `{HABR_SEARCH_URL}/api/search`, рендерит карточки, защита от двойного клика (ref-лок)

## Что пока заглушка

- ❌ **Wake word** — `web/src/voice/wakeword.ts` (интерфейс `WakeWordEngine` + TODO)
- ❌ **Speech-to-Text** — `web/src/voice/stt.ts` (интерфейс `STTEngine` + TODO)
- ❌ **OCR** — `web/src/screen/ocr.ts` (интерфейс `ScreenOCREngine` + TODO). Скриншот уже работает, осталось прицепить распознавание текста.
- ❌ **Вкладка «Настройки»** — пока показывает вкладку Habr (заглушка). Настройки (автозапуск) живут пока прямо в форме чата.

## План развития voice / screen модулей

### Wake word (`voice/wakeword.ts`)

| Библиотека | Плюсы | Минусы |
|---|---|---|
| **Porcupine** (Picovoice) | Очень точный, маленький движок, офлайн, есть готовая модель «computer» | Проприетарный, нужен access key |
| **Vosk-KWS** | Опенсорс, часть Vosk STT, полностью офлайн | Чуть ниже точность, нужен KWS-файл |

**Рекомендация:** начать с **Porcupine** (быстрее запустить), затем по желанию переехать на Vosk.

### Speech-to-Text (`voice/stt.ts`)

| Библиотека | Плюсы | Минусы |
|---|---|---|
| **Vosk** (WebAssembly) | Реально офлайн, маленькие модели (ru: `vosk-model-small-ru-0.22`, ~45 МБ), стабильный streaming | Чуть ниже WER, чем у Whisper |
| **Whisper.cpp** (WASM) | Лучшая точность, мультиязычный | Жирный (~150–1500 МБ), жрёт CPU/RAM |

**Рекомендация:** **Vosk** для прод-режима (маленький, быстрый), **Whisper** для точечных «серьёзных» расшифровок.

### OCR (`screen/ocr.ts`)

| Библиотека | Плюсы | Минусы |
|---|---|---|
| **Tesseract.js** (WASM) | Простой, опенсорс, офлайн | Средняя точность для кириллицы |
| **PaddleOCR** (WASM/Native) | Лучший опенсорс для кириллицы, точный | Тяжелее интеграция |
| **Vision API** (OpenAI / Google) | Лучшее качество, минимум кода | Нужен API-ключ, не офлайн |

**Рекомендация:** **PaddleOCR** для локального, **Vision API** для «когда качество важнее приватности».

### Архитектура интеграции (когда дойдёт дело)

1. Добавить в `src-tauri/Cargo.toml` нужные крейты (например, `whisper-rs`, `tesseract-rs`).
2. Прокинуть мост: фронт (`voice/*.ts`) → Tauri-команды → Rust-движок.
3. UI получает события (`emit('voice-partial', ...)`) и подсвечивает «слушаю…» / дописывает в чат.
4. Кнопка-микрофон в header чата → `startListening()` из `voice/stt.ts`.

## Скрипты

| Команда | Что делает |
|---|---|
| `npm run dev` | Только Vite (без Tauri — для отладки UI в браузере) |
| `npm run build` | TS-проверка + бандл фронта в `web/dist/` |
| `npm run tauri dev` | Запуск дев-режима Tauri (Rust + Vite + HMR) |
| `npm run tauri build` | Релизная сборка с .msi/.exe |

## Проверка

| Что | Как |
|---|---|
| Сборка фронта | `npm run build` (должен пройти без TS-ошибок) |
| Сборка Rust | `cargo build --manifest-path src-tauri/Cargo.toml` |
| Окно справа | `npm run tauri dev` — окно появится у правого края |
| Трей | Клик по иконке в трее — toggle; правый клик — меню |
| Хоткей | `Ctrl+Shift+Space` — toggle |
| Кнопка «свернуть» | Кнопка `▾` в header → окно прячется, иконка в трее остаётся |
| Крестик | В Tauri v2 при `decorations: false` системный крестик часто не виден — тогда работает хоткей/трей/кнопка `▾` |
| LLM-чат | Ввести сообщение → должен пойти стрим (текст появляется постепенно) |
| Стоп | Во время стрима кнопка `➤` превращается в `■` — клик прерывает |
| 📸 | Клик по 📸 → в чат упадёт превью скриншота + файл во временной папке |
| Автозапуск | Клик по ⚙ в форме чата → включает/выключает автозапуск ОС (видно в `msconfig` / `launchctl` / `systemd`) |
| Habr | Открыть вкладку, ввести «rust», нажать «Найти» (нужен запущенный `habr-search`) |

## Известные ограничения

- Сохранение позиции в `%APPDATA%\app.pulse.local\window-state.json` работает только в Tauri-окружении (не в браузере).
- `VITE_LLM_*` подставляются в JS-бандл на этапе сборки Vite (это требование Vite, а не Pulse). Если переключаешься на облачного провайдера — не публикуй бандл с реальным ключом в общий доступ.
- OCR/screen-recognition поверх скриншота пока не подключены — `web/src/screen/ocr.ts` остаётся интерфейсом-заглушкой.
- Стриминговый STT/wake-word пока не подключены — UI их не зовёт.
