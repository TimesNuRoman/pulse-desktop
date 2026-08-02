import { useState, useRef, useEffect, FormEvent } from 'react';
import { searchHabr } from '../api';
import type { HabrItem } from '../types';
import { usePullToRefresh } from '../mobile/usePullToRefresh';
import { ProRequiredError } from '../lib/license/types';
import { licenseStore } from '../lib/license/store';
import { UpgradeModal } from './PRO/UpgradeModal';

export function HabrSearch() {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<HabrItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [total, setTotal] = useState(0);
  // R119: gate modal — shown when a free user tries to run a search.
  const [gateOpen, setGateOpen] = useState(false);
  // Ref-лок против race condition: если юзер успеет дважды кликнуть «Найти»,
  // второй клик увидит актуальный флаг (а не stale closure из render).
  const inflight = useRef(false);
  // Текущий query для refresh
  const lastQuery = useRef('');

  // P0 фикс: error/offline баннер не должен «висеть» после ухода с таба.
  // Хотя условный рендер в App.tsx и так размонтирует компонент, добавляем
  // явный cleanup — на случай, если родитель начнёт кешировать инстанс.
  useEffect(() => {
    return () => {
      setError(null);
      setOffline(false);
      setLoading(false);
    };
  }, []);

  async function runSearch(q: string) {
    if (!q || inflight.current) return;
    // R119: PRO gate — web search is a paid feature. Throws ProRequiredError,
    // which we catch and surface via the upgrade modal.
    try {
      licenseStore.requirePro('web-search');
    } catch (e) {
      if (e instanceof ProRequiredError) {
        setGateOpen(true);
        return;
      }
      throw e;
    }
    inflight.current = true;
    setLoading(true);
    setError(null);
    setOffline(false);
    setSearched(true);
    try {
      const r = await searchHabr(q, 15);
      setItems(r.items);
      setTotal(r.total);
      setOffline(r.offline);
      if (r.error) setError(r.error);
    } catch (err) {
      setError(String(err));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    lastQuery.current = q;
    await runSearch(q);
  }

  // Pull-to-refresh: повторяет последний успешный запрос.
  const ptr = usePullToRefresh({
    onRefresh: async () => {
      if (lastQuery.current) await runSearch(lastQuery.current);
    },
  });

  return (
    <div
      className="habr"
      ref={ptr.containerRef as React.RefObject<HTMLDivElement>}
      data-ptr={ptr.pulling || ptr.refreshing ? '1' : '0'}
    >
      {ptr.spinner}
      <form className="habr__form" onSubmit={onSubmit}>
        <input
          className="habr__input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по Habr: rust, docker, llm…"
          autoFocus
          disabled={loading}
        />
        <button className="habr__btn" type="submit" disabled={loading || !query.trim()}>
          {loading ? '…' : 'Найти'}
        </button>
      </form>

      {error && <div className="habr__error">⚠ {error}</div>}
      {offline && !error && (
        <div className="habr__error">
          ⚠ habr-search оффлайн. Запусти:
          <br />
          <code>cd C:\Users\1\.minimax-agent\projects\habr-search &amp;&amp; npm run dev</code>
        </div>
      )}

      {searched && !loading && total > 0 && (
        <div className="habr__total">Найдено: {total}</div>
      )}

      {searched && !loading && items.length === 0 && !error && !offline && (
        <div className="habr__empty">Ничего не нашлось.</div>
      )}

      <ul className="habr__list">
        {items.map((it) => (
          <li key={it.url} className="habr__card">
            <a
              className="habr__title"
              href={it.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {it.title}
            </a>
            <div className="habr__meta">
              {it.author && <span>👤 {it.author}</span>}
              {it.time && <span>🕒 {it.time}</span>}
            </div>
            {it.snippet && <p className="habr__snippet">{it.snippet}</p>}
          </li>
        ))}
      </ul>

      {gateOpen && (
        <UpgradeModal
          feature="web-search"
          reason="click"
          onClose={() => setGateOpen(false)}
        />
      )}
    </div>
  );
}
