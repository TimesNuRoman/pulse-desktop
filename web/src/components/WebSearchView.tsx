import { useState, useRef, FormEvent } from 'react';
import { webSearch } from '../llm/tools';
import type { SearchItem, WebSearchResult } from '../llm/tools';
import { usePullToRefresh } from '../mobile/usePullToRefresh';

export function WebSearchView() {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [total, setTotal] = useState(0);
  const [backend, setBackend] = useState<string>('');
  // Ref-лок против race condition: двойной клик «Найти» увидит актуальный
  // флаг, а не stale closure из render.
  const inflight = useRef(false);
  const lastQuery = useRef('');

  async function runSearch(q: string) {
    if (!q || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    setError(null);
    setOffline(false);
    setSearched(true);
    try {
      const r: WebSearchResult = await webSearch(q, 8);
      setItems(r.items);
      setTotal(r.total);
      setBackend(r.backend);
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

  const ptr = usePullToRefresh({
    onRefresh: async () => {
      if (lastQuery.current) await runSearch(lastQuery.current);
    },
  });

  return (
    <div
      className="websearch"
      ref={ptr.containerRef as React.RefObject<HTMLDivElement>}
      data-ptr={ptr.pulling || ptr.refreshing ? '1' : '0'}
    >
      {ptr.spinner}
      <form className="websearch__form" onSubmit={onSubmit}>
        <input
          className="websearch__input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск в интернете: Rust 1.83, что такое SVE…"
          autoFocus
          disabled={loading}
        />
        <button
          className="websearch__btn"
          type="submit"
          disabled={loading || !query.trim()}
        >
          {loading ? '…' : '🔍 Найти'}
        </button>
      </form>

      {error && <div className="websearch__warn">⚠ {error}</div>}
      {offline && !error && (
        <div className="websearch__warn">
          ⚠ web_search оффлайн. Проверь интернет-соединение.
        </div>
      )}

      {searched && !loading && total > 0 && (
        <div className="websearch__meta">
          Найдено: {total} · источник: <code>{backend}</code>
        </div>
      )}

      {searched && !loading && items.length === 0 && !error && !offline && (
        <div className="websearch__empty">Ничего не нашлось.</div>
      )}

      <ul className="websearch__list">
        {items.map((it) => (
          <li key={it.url} className="websearch__card">
            <div className="websearch__row">
              <a
                className="websearch__title"
                href={it.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {it.title}
              </a>
              <span className="websearch__src" data-source={it.source}>
                {it.site_name}
              </span>
            </div>
            {it.snippet && <p className="websearch__snippet">{it.snippet}</p>}
            <div className="websearch__url">{it.url}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
