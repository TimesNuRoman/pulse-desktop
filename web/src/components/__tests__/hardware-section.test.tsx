// SPDX-License-Identifier: Apache-2.0
// Pulse R175 — HardwareSection component tests.
//
// В happy-dom (vitest). Tauri-инвок недоступен → мокаем api.detectHardware().
// Web-детектор (WebGL) тоже мокаем — happy-dom не имеет реального WebGL.
// Clipboard API мокаем через Object.defineProperty.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// Мокаем api.ts ДО импорта HardwareSection.
vi.mock('../../api', () => ({
  detectHardware: vi.fn().mockResolvedValue({
    arch: 'x86_64',
    os: { name: 'Windows', version: '10.0.22631', kernel: '10.0.22631', arch: 'x86_64' },
    cpu: { brand: 'AMD Ryzen 7 5800X', cores: 8, threads: 16, frequency_mhz: 3800 },
    ram: { total_gb: 16, available_gb: 8 },
    disk: { mount: 'C:\\', total_gb: 500, free_gb: 200 },
    gpus: [],
    recommended_tier: 'High',
  }),
  IS_DESKTOP: true,
  IS_MOBILE: false,
}));

// Мокаем hardwareDetector (web-side WebGL).
vi.mock('../../lib/hardwareDetector', () => ({
  detectHardware: vi.fn().mockResolvedValue({
    cpu: { cores: 8, model: 'unknown' },
    ram: 16,
    gpu: { vendor: 'NVIDIA', renderer: 'GeForce RTX 3060' },
    os: 'Windows',
    disk: 'unknown',
    screen: { width: 1920, height: 1080, dpi: 1 },
    language: 'en-US',
  }),
}));

// Мокаем Tauri clipboard plugin (динамический импорт в HardwareSection).
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

import { HardwareSection } from '../settings/HardwareSection';

interface Harness {
  root: Root;
  container: HTMLDivElement;
}

function mount(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<HardwareSection />);
  });
  return { root, container };
}

function unmount(h: Harness) {
  act(() => {
    h.root.unmount();
  });
  document.body.removeChild(h.container);
}

async function flush() {
  // React 18 batches state updates. Несколько await'ов дают микротаскам
  // отработать (resolve промисов из useEffect + setState).
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('HardwareSection', () => {
  test('renders detected hardware in About section', async () => {
    const h = mount();
    try {
      await flush();
      const section = h.container.querySelector('[data-testid="hardware-section"]');
      expect(section).not.toBeNull();
      // CPU + RAM из моков должны быть видны.
      const cpu = h.container.querySelector('[data-testid="hw-cpu"]');
      const ram = h.container.querySelector('[data-testid="hw-ram"]');
      const gpu = h.container.querySelector('[data-testid="hw-gpu"]');
      const os = h.container.querySelector('[data-testid="hw-os"]');
      expect(cpu?.textContent).toContain('AMD Ryzen 7 5800X');
      expect(ram?.textContent).toContain('16');
      expect(gpu?.textContent).toContain('NVIDIA');
      expect(os?.textContent).toContain('Windows');
    } finally {
      unmount(h);
    }
  });

  test('renders model recommendations as cards', async () => {
    const h = mount();
    try {
      await flush();
      const cards = h.container.querySelectorAll('[data-testid="hw-model-card"]');
      expect(cards.length).toBeGreaterThanOrEqual(1);
      expect(cards.length).toBeLessThanOrEqual(3);
      // Каждая карточка должна иметь installCommand + copy-button.
      const cmds = h.container.querySelectorAll('[data-testid="hw-install-cmd"]');
      const copyBtns = h.container.querySelectorAll('[data-testid="hw-copy-btn"]');
      expect(cmds.length).toBe(cards.length);
      expect(copyBtns.length).toBe(cards.length);
      // Первая рекомендация для 16 GB должна быть gemma3:8b (High).
      expect(cards[0].textContent).toContain('gemma3:8b');
    } finally {
      unmount(h);
    }
  });

  test('click "Refresh" re-detects and updates display', async () => {
    const apiMod = await import('../../api');
    const hwMod = await import('../../lib/hardwareDetector');
    const detectHardwareSpy = vi.mocked(apiMod.detectHardware);
    const webDetectSpy = vi.mocked(hwMod.detectHardware);
    detectHardwareSpy.mockClear();
    webDetectSpy.mockClear();

    const h = mount();
    try {
      await flush();
      // Initial mount уже дёрнул detect — spy.mock.calls.length === 1.
      const initialCalls = detectHardwareSpy.mock.calls.length;
      expect(initialCalls).toBeGreaterThanOrEqual(1);

      // Меняем mock, чтобы Refresh увидел другие данные.
      detectHardwareSpy.mockResolvedValueOnce({
        arch: 'x86_64',
        os: { name: 'Linux', version: '6.5.0', kernel: '6.5.0', arch: 'x86_64' },
        cpu: { brand: 'Intel i9', cores: 24, threads: 32, frequency_mhz: 3000 },
        ram: { total_gb: 64, available_gb: 32 },
        disk: { mount: '/', total_gb: 1000, free_gb: 500 },
        gpus: [],
        recommended_tier: 'Ultra',
      });

      // Кликаем Refresh. Ищем кнопку по aria-label.
      const refreshBtn = h.container.querySelector('button[aria-label="Refresh hardware detection"]');
      expect(refreshBtn).not.toBeNull();
      await act(async () => {
        (refreshBtn as HTMLButtonElement).click();
      });
      await flush();

      // После клика — detect вызвался ещё раз.
      expect(detectHardwareSpy.mock.calls.length).toBeGreaterThan(initialCalls);
      // Новые данные подтянулись.
      const cpu = h.container.querySelector('[data-testid="hw-cpu"]');
      expect(cpu?.textContent).toContain('Intel i9');
    } finally {
      unmount(h);
    }
  });

  test('copy-to-clipboard button copies install command', async () => {
    const clipMod = await import('@tauri-apps/plugin-clipboard-manager');
    const writeSpy = vi.mocked(clipMod.writeText);
    writeSpy.mockClear();

    const h = mount();
    try {
      await flush();
      const copyBtns = h.container.querySelectorAll<HTMLButtonElement>('[data-testid="hw-copy-btn"]');
      expect(copyBtns.length).toBeGreaterThan(0);
      const firstBtn = copyBtns[0];
      const firstCmd = h.container.querySelector<HTMLElement>('[data-testid="hw-install-cmd"]')?.textContent;
      expect(firstCmd).toMatch(/^ollama pull \S+$/);

      await act(async () => {
        firstBtn.click();
      });
      // Микрозадача для промиса writeText.
      await act(async () => {
        await Promise.resolve();
      });

      expect(writeSpy).toHaveBeenCalledWith(firstCmd);
    } finally {
      unmount(h);
    }
  });
});
