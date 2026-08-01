// Pulse mobile-iteration 17 — pull-to-refresh hook.
//
// Использование:
//   const ptr = usePullToRefresh({ onRefresh: async () => { await reload(); } });
//   <div ref={ptr.containerRef} className={ptr.pulling ? 'is-pulling' : ''}>
//     {ptr.spinner}
//     ...list...
//   </div>
//
// Поведение:
//  - Только для touch-устройств (HAS_TOUCH).
//  - Триггерится когда scrollTop === 0 И пользователь тянет вниз ≥ 60px.
//  - При отпускании после 60px — вызывает onRefresh() и показывает спиннер
//    600мс минимум (чтобы не мигало). Pull-state сбрасывается после refresh.
//  - Не блокирует обычный скролл вниз.

import { useEffect, useRef, useState, useCallback } from 'react';

const HAS_TOUCH =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || (navigator as any).maxTouchPoints > 0);

const PULL_THRESHOLD = 60; // px до триггера
const PULL_MAX = 110;      // visual cap
const REFRESH_MIN_MS = 600;

export interface PullState {
  /** ref на scrollable container (привязать в JSX) */
  containerRef: React.RefObject<HTMLElement>;
  /** true, пока юзер тянет вниз */
  pulling: boolean;
  /** px pulled (0..PULL_MAX) */
  offset: number;
  /** true во время refresh (onRefresh выполняется) */
  refreshing: boolean;
  /** JSX со спиннером/индикатором — вставить в начало списка */
  spinner: React.ReactNode;
}

export function usePullToRefresh(opts: {
  onRefresh: () => void | Promise<void>;
}): PullState {
  const containerRef = useRef<HTMLElement>(null);
  const [pulling, setPulling] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const offsetRef = useRef(0);
  const refreshingRef = useRef(false);

  const doRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const start = Date.now();
    try {
      await opts.onRefresh();
    } finally {
      const elapsed = Date.now() - start;
      const wait = Math.max(0, REFRESH_MIN_MS - elapsed);
      setTimeout(() => {
        refreshingRef.current = false;
        setRefreshing(false);
        setOffset(0);
        offsetRef.current = 0;
      }, wait);
    }
  }, [opts]);

  useEffect(() => {
    if (!HAS_TOUCH) return;
    const el = containerRef.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      if (refreshingRef.current) return;
      // Только если scroll в самом верху
      if (el!.scrollTop > 0) return;
      startY.current = e.touches[0]?.clientY ?? null;
    }
    function onTouchMove(e: TouchEvent) {
      if (startY.current == null) return;
      if (refreshingRef.current) return;
      const y = e.touches[0]?.clientY ?? startY.current;
      const dy = y - startY.current;
      if (dy <= 0) {
        // тянет вверх — обычный скролл, не наш случай
        if (offsetRef.current !== 0) {
          offsetRef.current = 0;
          setOffset(0);
          setPulling(false);
        }
        return;
      }
      if (el!.scrollTop > 0) {
        startY.current = null;
        return;
      }
      // resistance (резиновый pull)
      const damped = Math.min(PULL_MAX, dy * 0.45);
      offsetRef.current = damped;
      setOffset(damped);
      setPulling(true);
    }
    async function onTouchEnd() {
      if (startY.current == null) return;
      const dy = offsetRef.current;
      startY.current = null;
      if (dy >= PULL_THRESHOLD) {
        // дёрнем — refresh
        void doRefresh();
      } else {
        offsetRef.current = 0;
        setOffset(0);
        setPulling(false);
      }
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [doRefresh]);

  const visible = pulling || refreshing;
  const progress = Math.min(1, offset / PULL_THRESHOLD);
  const spinner = (
    <div
      className="ptr"
      data-state={refreshing ? 'refreshing' : pulling ? 'pulling' : 'idle'}
      style={{ height: visible ? Math.max(offset, refreshing ? 44 : 0) : 0 }}
      aria-hidden={!visible}
    >
      <div className="ptr__inner" style={{ opacity: progress || refreshing ? 1 : 0 }}>
        {refreshing ? '⏳' : progress >= 1 ? '↻ отпусти' : '↓ тяни'}
      </div>
    </div>
  );

  return { containerRef, pulling, offset, refreshing, spinner };
}
