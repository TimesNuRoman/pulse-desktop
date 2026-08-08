// R248 visual-verify script.
// Starts a tiny in-process http server pointing at the built
// dist/, opens it in puppeteer at 3 viewports (1440 / 768 / 375),
// injects a __TAURI_INTERNALS__ shim so the chat view's IN_TAURI
// code paths execute (and silently swallow the no-op invoke
// rejections), and screenshots the result.
//
// The popover-open shot is taken by clicking the [☰ History]
// button before screenshotting at 1440.
//
// Output:
//   C:\Users\1\.minimax\workspace\downloads\verify\2026-08-08\r248-raycast-{1440,768,375,history-open-1440}.png

import { createServer } from 'node:http';
import { readFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { promisify } from 'node:util';

const sleep = promisify(setTimeout);

const DIST = resolve('H:/.sandbox/projects/pulse-desktop-r248/web/dist');
const OUT_DIR = 'C:/Users/1/.minimax/workspace/downloads/verify/2026-08-08';

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serve(rootDir) {
  return createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const target = urlPath === '/' ? '/index.html' : urlPath;
    const full = join(rootDir, target);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        const idx = join(full, 'index.html');
        const data = readFileSync(idx);
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data);
        return;
      }
      const data = readFileSync(full);
      res.writeHead(200, {
        'Content-Type': MIME[extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + target);
    }
  });
}

const PORT = 18765;
const server = serve(DIST);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`[r248] static server up on http://127.0.0.1:${PORT}`);

let puppeteer;
try {
  puppeteer = (await import('puppeteer')).default;
} catch (e) {
  console.error('Failed to import puppeteer:', e.message);
  server.close();
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

async function shot(viewport, suffix, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);

  // Inject the Tauri shim BEFORE the page scripts run so IN_TAURI
  // resolves to true at module-load. The shim's invoke() returns
  // sensible defaults for the calls ChatView makes on mount.
  await page.evaluateOnNewDocument(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: function (cmd, args) {
        if (cmd === 'get_autostart') return Promise.resolve(false);
        if (cmd === 'get_active_text_model')
          return Promise.resolve({ model: 'gemma3:4b', vision_model: 'llava:7b' });
        if (cmd === 'plugin:autostart|is_enabled') return Promise.resolve(false);
        if (cmd === 'engine_decide')
          return Promise.resolve({
            preferredModel: 'default',
            fallbackModel: 'default',
            fired: [],
            score: 0,
            threshold: 5,
            flipped: false,
            codeParseSignal: false,
            lowConfidence: false,
          });
        return Promise.reject(new Error('demo-r248 shim: ' + cmd));
      },
      transformCallback: function (cb) { return cb; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    };
    window.__TAURI__ = { core: { invoke: window.__TAURI_INTERNALS__.invoke } };
    window.Capacitor = undefined;
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0', timeout: 30000 });

  // Seed localStorage BEFORE the app boots so the onboarding modal is
  // skipped and the chat view comes up unobstructed. Also seed two
  // history rows so the popover screenshot is interesting.
  await page.evaluate((seed) => {
    localStorage.setItem('pulse.onboarding.completed.v1', 'true');
    localStorage.setItem('pulse.onboarding.completed.v1.ts', String(Date.now()));
    // Pre-set routing override to QuickAnswer so the Ask pill shows as active.
    localStorage.setItem('pulse.routing.override', 'QuickAnswer');
    if (seed) {
      const now = new Date();
      const t = (offsetMin) => new Date(now.getTime() - offsetMin * 60_000).toISOString();
      const chats = {
        a: {
          id: 'a',
          title: 'Pulse — переход на Rust движок',
          messages: [
            { id: 'au', role: 'user', content: 'План переезда на Rust для Smart Engine v3', ts: 1 },
            { id: 'aa', role: 'assistant', content: '## План\n\n1. **Базовый engine** — перенести `routing_decide` из TypeScript в Rust crate (`src-tauri/src/engine/`). Тесты на входе/выходе совпадают с текущими.\n2. **HTTP-вызов** — заменить fetch-loop в `streamChat` на `reqwest` с тем же `chat/completions` интерфейсом.\n3. **Агентурный цикл** — `runAgentLoop` тоже в Rust (он уже вызывается как `engine_invoke`, нужна только доработка под R194).', ts: 2 },
          ],
          lastMessageAt: t(8),
        },
        b: {
          id: 'b',
          title: 'R248: Raycast single column',
          messages: [
            { id: 'bu', role: 'user', content: 'Что в этом раунде меняем по UI?', ts: 1 },
            { id: 'ba', role: 'assistant', content: 'Убираем левый сайдбар. История чатов уезжает в popover по [☰ History] в шапке. Routing mode pills — горизонтальный tablist под topbar.', ts: 2 },
          ],
          lastMessageAt: t(40),
        },
        c: {
          id: 'c',
          title: 'R246: paper-plane adaptive icon',
          messages: [
            { id: 'cu', role: 'user', content: 'Замени P+spark на paper-plane из R244 EmptyState', ts: 1 },
            { id: 'ca', role: 'assistant', content: 'Сделано. 5 файлов MOD, 0 new deps. Adaptive-icon safe zone 21..87 соблюдён.', ts: 2 },
          ],
          lastMessageAt: t(180),
        },
        d: {
          id: 'd',
          title: 'LLM-бэкенд: кандидаты на multi-model',
          messages: [
            { id: 'du', role: 'user', content: 'q', ts: 1 },
            { id: 'da', role: 'assistant', content: 'a', ts: 2 },
          ],
          lastMessageAt: t(720),
        },
      };
      localStorage.setItem('pulse.chat.history.v1', JSON.stringify({ chats }));
    }
  }, opts.popover);

  await page.reload({ waitUntil: 'networkidle0' });
  // Wait for the chat root to mount.
  await page.waitForSelector('.raycast-chat', { timeout: 10000 });
  // Bypass any .reveal animations just in case.
  await page.evaluate(() => {
    document.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-visible'));
  });
  await sleep(opts.popover ? 200 : 700);

  if (opts.popover) {
    await page.click('[data-testid="raycast-history-btn"]');
    await sleep(500);
  }

  const out = `${OUT_DIR}/r248-raycast-${suffix}.png`;
  await page.screenshot({ path: out, fullPage: false });
  console.log(`[r248] saved ${out}`);
  await page.close();
}

try {
  await shot({ width: 1440, height: 900, deviceScaleFactor: 1 }, '1440');
  await shot({ width: 768, height: 1024, deviceScaleFactor: 1 }, '768');
  await shot({ width: 375, height: 667, deviceScaleFactor: 1 }, '375');
  await shot({ width: 1440, height: 900, deviceScaleFactor: 1 }, 'history-open-1440', { popover: true });
} catch (e) {
  console.error('[r248] shot failed:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
