// SPDX-License-Identifier: Apache-2.0
// Pulse R175 — hardwareDetector tests.
//
// Тестируем в happy-dom (vitest config). happy-dom даёт `navigator`, но
// `hardwareConcurrency` / `deviceMemory` / WebGL / userAgentData — нет. Мы
// подменяем их через Object.defineProperty + мокаем HTMLCanvasElement.getContext.
//
// 7 тестов покрывают happy-path + missing-API graceful fallback.

import { describe, test, expect, vi, afterEach } from 'vitest';
import { detectHardware } from '../hardwareDetector';

interface NavPatch {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  language?: string;
  platform?: string;
  userAgentData?: { platform?: string };
  userAgent?: string;
}

function patchNavigator(patch: NavPatch) {
  const nav = navigator as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      // Удаляем поле (delete), чтобы fallback на 'unknown' сработал.
      try {
        delete nav[k];
      } catch {
        nav[k] = undefined;
      }
    } else {
      Object.defineProperty(nav, k, {
        value: v,
        configurable: true,
        writable: true,
      });
    }
  }
}

function mockGpu(vendor: string, renderer: string) {
  const fakeGl = {
    VENDOR: 0x1f00,
    RENDERER: 0x1f01,
    getExtension: vi.fn().mockReturnValue({
      UNMASKED_VENDOR_WEBGL: 0x9245,
      UNMASKED_RENDERER_WEBGL: 0x9246,
    }),
    getParameter: vi.fn((p: number) => {
      if (p === 0x9245) return vendor;
      if (p === 0x9246) return renderer;
      return '';
    }),
  } as unknown as WebGLRenderingContext;
  const original = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    contextId: string,
  ) {
    if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') {
      return fakeGl as unknown as RenderingContext;
    }
    return original.call(this, contextId) as RenderingContext | null;
  });
}

function unmockGpu() {
  vi.restoreAllMocks();
}

afterEach(() => {
  unmockGpu();
});

describe('detectHardware — happy paths', () => {
  test('returns CPU cores from navigator.hardwareConcurrency', async () => {
    patchNavigator({ hardwareConcurrency: 16 });
    const info = await detectHardware();
    expect(info.cpu.cores).toBe(16);
  });

  test('returns RAM from navigator.deviceMemory', async () => {
    patchNavigator({ deviceMemory: 8 });
    const info = await detectHardware();
    expect(info.ram).toBe(8);
  });

  test('extracts GPU from WebGL WEBGL_debug_renderer_info', async () => {
    mockGpu('NVIDIA Corporation', 'GeForce RTX 3060/PCIe/SSE2');
    const info = await detectHardware();
    expect(info.gpu).not.toBeNull();
    expect(info.gpu?.vendor).toBe('NVIDIA Corporation');
    expect(info.gpu?.renderer).toContain('RTX 3060');
  });

  test('returns screen dimensions from screen object', async () => {
    // happy-dom даёт screen — проверим что width/height/dpi возвращаются.
    // Поля могут быть 0 в headless-окружении, но должны быть number.
    const info = await detectHardware();
    expect(typeof info.screen.width).toBe('number');
    expect(typeof info.screen.height).toBe('number');
    expect(typeof info.screen.dpi).toBe('number');
    expect(info.screen.dpi).toBeGreaterThan(0); // devicePixelRatio ≥ 1
  });

  test('returns language from navigator.language', async () => {
    patchNavigator({ language: 'ru-RU' });
    const info = await detectHardware();
    expect(info.language).toBe('ru-RU');
  });
});

describe('detectHardware — graceful fallback', () => {
  test('returns "unknown" when APIs unavailable', async () => {
    // happy-dom не даёт удалить hardwareConcurrency через defineProperty —
    // у него собственный non-configurable геттер. Подменяем navigator
    // целиком через vi.stubGlobal.
    const stubNav = {} as unknown as Navigator;
    vi.stubGlobal('navigator', stubNav);
    try {
      // Без WebGL mock — getContext('webgl') вернёт null → gpu: null.
      const info = await detectHardware();
      expect(info.cpu.cores).toBe('unknown');
      expect(info.ram).toBe('unknown');
      expect(info.gpu).toBeNull();
      expect(info.os).toBe('unknown');
      expect(info.language).toBe('unknown');
      expect(info.disk).toBe('unknown');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('never throws on missing API', async () => {
    const stubNav = {} as unknown as Navigator;
    vi.stubGlobal('navigator', stubNav);
    try {
      await expect(detectHardware()).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
