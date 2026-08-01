// Pulse v5 — SmartPanel: вкладки "Запустить" / "Игры" / "Система".
// Чат живёт отдельно (ChatView), эта панель — ручной доступ к тем же tools
// без LLM. Полезно когда хочется быстро поднять игру или глянуть состояние
// машины, не отвлекая модель.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  listInstalledApps,
  findApp,
  launchApp,
  listGames,
  listRunningProcesses,
  systemInfo,
  openUrl,
  youtubeLatest,
} from '../api';
import { listDirectory } from '../files/filesApi';
import type {
  AppInfo,
  GameInfo,
  ProcInfo,
  SysInfo,
  LaunchResult,
  YoutubeVideo,
} from '../types';

type Tab = 'launch' | 'games' | 'system' | 'youtube';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'launch', label: 'Запустить', icon: '🚀' },
  { id: 'games', label: 'Игры', icon: '🎮' },
  { id: 'system', label: 'Система', icon: '⚙️' },
  { id: 'youtube', label: 'YouTube', icon: '🎬' },
];

export function AgentPanel() {
  const [tab, setTab] = useState<Tab>('launch');
  return (
    <div className="agent">
      <div className="agent__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`agent__tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="agent__tab-ico" aria-hidden>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="agent__body">
        {tab === 'launch' && <LaunchView />}
        {tab === 'games' && <GamesView />}
        {tab === 'system' && <SystemView />}
        {tab === 'youtube' && <YoutubeView />}
      </div>
    </div>
  );
}

// ─── Запустить (поиск приложения + запуск) ────────────────────────────────

function LaunchView() {
  const [query, setQuery] = useState('');
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [hits, setHits] = useState<AppInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [launchBusy, setLaunchBusy] = useState<string | null>(null);
  const [lastLaunch, setLastLaunch] = useState<{ name: string; res: LaunchResult } | null>(null);
  const debounceRef = useRef<number | null>(null);

  // При первом монтировании — подгружаем кэш (для отображения total)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listInstalledApps();
        if (!cancelled) setApps(all);
      } catch (e) {
        if (!cancelled) setErr(`apps: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounce поиска
  useEffect(() => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
    }
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await findApp(q);
        setHits(r);
      } catch (e) {
        setErr(`find: ${(e as Error).message}`);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  async function doLaunch(a: AppInfo) {
    if (launchBusy) return;
    setLaunchBusy(a.path);
    setErr(null);
    try {
      const res = await launchApp(a.path);
      setLastLaunch({ name: a.name, res });
    } catch (e) {
      setErr(`launch: ${(e as Error).message}`);
    } finally {
      setLaunchBusy(null);
    }
  }

  const list = hits ?? apps.slice(0, 50);
  const showAll = hits == null;

  return (
    <div className="launch">
      <div className="launch__inputwrap">
        <input
          className="launch__input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Поиск среди ${apps.length} приложений…`}
          autoFocus
        />
        {loading && <span className="launch__spinner">…</span>}
      </div>

      {err && <div className="launch__err">⚠ {err}</div>}

      {lastLaunch && (
        <div className="launch__last">
          ✅ <b>{lastLaunch.name}</b> запущено
          {lastLaunch.res.pid != null ? ` (pid=${lastLaunch.res.pid})` : ''}.
        </div>
      )}

      <div className="launch__list">
        {list.length === 0 && !loading && (
          <div className="launch__empty">
            {query.trim()
              ? `По «${query.trim()}» ничего не нашлось.`
              : 'Список пуст. Скан может занять 10-20 сек в первый раз.'}
          </div>
        )}
        {list.map((a) => (
          <div key={`${a.path}-${a.source}`} className="launch__row">
            <div className="launch__row-main">
              <div className="launch__row-name" title={a.path}>
                {a.name}
              </div>
              <div className="launch__row-meta">
                <span className="launch__src" data-src={a.source}>
                  {sourceIcon(a.source)} {a.source}
                </span>
                {a.version && <span className="launch__ver">v{a.version}</span>}
                <span className="launch__path" title={a.path}>
                  {trimPath(a.path)}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="launch__btn"
              onClick={() => void doLaunch(a)}
              disabled={launchBusy === a.path}
              title={a.path}
            >
              {launchBusy === a.path ? '…' : '▶'}
            </button>
          </div>
        ))}
      </div>

      {showAll && list.length > 0 && (
        <div className="launch__hint">
          Показаны первые {list.length} из {apps.length}. Введите запрос для поиска.
        </div>
      )}
    </div>
  );
}

function sourceIcon(s: string): string {
  if (s === 'registry') return '📦';
  if (s === 'package') return '🧩';
  if (s === 'lnk') return '🔗';
  if (s === 'folder') return '📁';
  return '•';
}

function trimPath(p: string): string {
  if (p.length <= 50) return p;
  return '…' + p.slice(-48);
}

// ─── Игры ─────────────────────────────────────────────────────────────────

function GamesView() {
  const [games, setGames] = useState<GameInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await listGames();
        if (!cancelled) setGames(r);
      } catch (e) {
        if (!cancelled) setErr(`games: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!games) return [];
    const f = filter.trim().toLowerCase();
    if (!f) return games;
    return games.filter(
      (g) =>
        g.name.toLowerCase().includes(f) ||
        g.source.toLowerCase().includes(f) ||
        g.appid.includes(f),
    );
  }, [games, filter]);

  async function doLaunch(g: GameInfo) {
    if (launching) return;
    if (!g.install_path) {
      setErr(`У игры «${g.name}» нет install_path — запуск невозможен.`);
      return;
    }
    setLaunching(g.appid);
    setErr(null);
    try {
      // Steam можно запустить через steam://run/<appid>
      if (g.source === 'steam' && g.appid) {
        await launchApp(`steam://run/${g.appid}`);
      } else {
        // Ищем .exe в install_path (берём первый попавшийся)
        const exe = await guessExeIn(g.install_path);
        if (!exe) {
          throw new Error(`В ${g.install_path} не нашёл .exe`);
        }
        await launchApp(exe);
      }
    } catch (e) {
      setErr(`launch «${g.name}»: ${(e as Error).message}`);
    } finally {
      setLaunching(null);
    }
  }

  return (
    <div className="games">
      <div className="games__head">
        <input
          className="games__filter"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={
            games
              ? `Игр: ${games.length}. Фильтр…`
              : 'Сканирую Steam / Epic / GOG…'
          }
          disabled={!games}
        />
      </div>
      {err && <div className="launch__err">⚠ {err}</div>}
      {games === null && <div className="games__loading">⏳ Парсю лаунчеры…</div>}
      {games && filtered.length === 0 && (
        <div className="launch__empty">
          {filter.trim()
            ? `По «${filter}» ничего не нашлось.`
            : 'Игры не найдены. Убедись, что Steam установлен и библиотека просканирована.'}
        </div>
      )}
      <div className="games__list">
        {filtered.map((g) => (
          <div key={`${g.source}-${g.appid}`} className="games__row">
            <div className="games__row-main">
              <div className="games__row-name">{g.name}</div>
              <div className="games__row-meta">
                <span className="games__src" data-src={g.source}>
                  {g.source}
                </span>
                <span className="games__appid">appid {g.appid}</span>
                {g.last_played > 0 && (
                  <span className="games__last">
                    {formatLastPlayed(g.last_played)}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="launch__btn"
              onClick={() => void doLaunch(g)}
              disabled={launching === g.appid}
              title={g.install_path || 'нет install_path'}
            >
              {launching === g.appid ? '…' : '▶'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatLastPlayed(ms: number): string {
  const days = Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000));
  if (days < 1) return 'сегодня';
  if (days < 7) return `${days}д назад`;
  if (days < 30) return `${Math.floor(days / 7)}нед назад`;
  if (days < 365) return `${Math.floor(days / 30)}мес назад`;
  return `${Math.floor(days / 365)}год назад`;
}

/** Эвристика: первый .exe в install_path или на 1 уровень вниз. */
async function guessExeIn(root: string): Promise<string | null> {
  // Используем существующую команду find_first_exe через api... но проще:
  // пробуем стандартные имена exe-файлов на основе имени папки.
  // Если ничего не нашлось — возвращаем null и пусть UI ругнётся.
  try {
    const top = await listDirectory(root);
    const exe = top.entries.find(
      (e) => e.isFile && e.name.toLowerCase().endsWith('.exe'),
    );
    if (exe) return exe.path;
    // если не нашли — заглянем в подпапки (одна попытка)
    for (const dir of top.entries.filter((e) => e.isDir).slice(0, 8)) {
      try {
        const inner = await listDirectory(dir.path);
        const innerExe = inner.entries.find(
          (e) => e.isFile && e.name.toLowerCase().endsWith('.exe'),
        );
        if (innerExe) return innerExe.path;
      } catch {
        /* permission denied и т.п. */
      }
    }
  } catch {
    /* root недоступен */
  }
  return null;
}

// ─── Система ──────────────────────────────────────────────────────────────

function SystemView() {
  const [sys, setSys] = useState<SysInfo | null>(null);
  const [procs, setProcs] = useState<ProcInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    setErr(null);
    try {
      const [s, p] = await Promise.all([systemInfo(), listRunningProcesses()]);
      setSys(s);
      setProcs(p);
    } catch (e) {
      setErr(`sys: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="sys">
      <div className="sys__head">
        <button
          type="button"
          className="sys__refresh"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {refreshing ? '⏳ Обновляю…' : '🔄 Обновить'}
        </button>
        {err && <span className="sys__err">⚠ {err}</span>}
      </div>
      {sys && (
        <div className="sys__cards">
          <div className="sys__card">
            <div className="sys__card-title">CPU</div>
            <div className="sys__card-main">{sys.cpu_brand}</div>
            <div className="sys__card-sub">
              {sys.cpu_cores} ядер · <b>{sys.cpu_usage_pct.toFixed(1)}%</b>
            </div>
            <Bar value={sys.cpu_usage_pct} max={100} />
          </div>
          <div className="sys__card">
            <div className="sys__card-title">RAM</div>
            <div className="sys__card-main">
              {sys.ram_used_gb.toFixed(1)} / {sys.ram_total_gb.toFixed(1)} ГБ
            </div>
            <div className="sys__card-sub">
              {sys.ram_total_gb > 0
                ? `${((sys.ram_used_gb / sys.ram_total_gb) * 100).toFixed(0)}% занято`
                : '—'}
            </div>
            <Bar
              value={sys.ram_used_gb}
              max={Math.max(sys.ram_total_gb, 0.1)}
            />
          </div>
          {sys.disks.map((d) => {
            const used = d.total_gb - d.free_gb;
            const pct = d.total_gb > 0 ? (used / d.total_gb) * 100 : 0;
            return (
              <div key={d.mount} className="sys__card">
                <div className="sys__card-title">Disk {d.mount}</div>
                <div className="sys__card-main">
                  {used.toFixed(1)} / {d.total_gb.toFixed(1)} ГБ
                </div>
                <div className="sys__card-sub">
                  {pct.toFixed(0)}% занято · свободно {d.free_gb.toFixed(1)} ГБ
                </div>
                <Bar value={pct} max={100} />
              </div>
            );
          })}
          <div className="sys__card">
            <div className="sys__card-title">Uptime</div>
            <div className="sys__card-main">
              {formatUptime(sys.uptime_secs)}
            </div>
            <div className="sys__card-sub">
              с момента последней загрузки
            </div>
          </div>
        </div>
      )}

      <div className="sys__procs">
        <div className="sys__procs-title">
          Топ процессов по памяти
          {procs && <span className="sys__procs-count"> ({procs.length})</span>}
        </div>
        {procs && (
          <div className="sys__procs-list">
            {procs.map((p) => (
              <div key={p.pid} className="sys__proc">
                <span className="sys__proc-name" title={`pid ${p.pid}`}>
                  {p.name}
                </span>
                <span className="sys__proc-mem">{p.memory_mb.toFixed(0)} МБ</span>
                <span className="sys__proc-cpu">
                  {p.cpu_pct >= 1 ? `${p.cpu_pct.toFixed(0)}%` : '<1%'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="sys__bar">
      <div className="sys__bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

// ─── YouTube (последние видео с канала) ────────────────────────────────────

function YoutubeView() {
  const [query, setQuery] = useState('');
  const [videos, setVideos] = useState<YoutubeVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const inflight = useRef(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    setErr(null);
    setSearched(true);
    try {
      const r = await youtubeLatest(q, 10);
      setVideos(r.videos);
      setChannelId(r.channel_id);
      if (r.error) setErr(r.error);
    } catch (e2) {
      setErr(String(e2));
      setVideos([]);
      setChannelId(null);
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  }

  return (
    <div className="youtube">
      <form className="youtube__form" onSubmit={onSubmit}>
        <input
          className="youtube__input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Канал: "куплинов", "@kuplinovplay" или URL…'
          autoFocus
          disabled={loading}
        />
        <button
          className="youtube__btn"
          type="submit"
          disabled={loading || !query.trim()}
        >
          {loading ? '…' : 'Найти'}
        </button>
      </form>

      <div className="youtube__hint">
        RSS YouTube: без API-ключей, до 15 последних видео. Если имя не резолвится — вставь URL.
      </div>

      {err && <div className="youtube__error">⚠ {err}</div>}

      {channelId && !err && (
        <div className="youtube__hint">Канал: <code>{channelId}</code></div>
      )}

      {searched && !loading && videos.length === 0 && !err && (
        <div className="youtube__empty">Видео не нашлись.</div>
      )}

      <ul className="youtube__list">
        {videos.map((v) => (
          <li key={v.url} className="youtube__card">
            <a
              className="youtube__title"
              href={v.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {v.title}
            </a>
            <div className="youtube__meta">
              {v.channel && <span className="youtube__ch">{v.channel}</span>}
              {v.published && (
                <span>🕒 {new Date(v.published).toISOString().slice(0, 10)}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── unused helper (избегаем TS-ворнинга) ─────────────────────────────────
// Прячем openUrl, чтобы дерево зависимостей оставалось согласованным,
// даже если v5-UI пока не использует его из этого компонента.
void openUrl;
