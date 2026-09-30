import { afterEach, describe, expect, it, vi } from 'vitest';
import { readThemePref, resolveTheme, saveThemePref } from './theme';

afterEach(() => vi.unstubAllGlobals());

describe('theme preference', () => {
  it('follows the system by default and when storage is unavailable', () => {
    // No localStorage at all (as in a locked-down browser): must not throw.
    expect(readThemePref()).toBe('system');
    expect(() => saveThemePref('dark')).not.toThrow();
  });

  it('reads back a valid saved choice and ignores junk', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });
    saveThemePref('dark');
    expect(readThemePref()).toBe('dark');
    saveThemePref('light');
    expect(readThemePref()).toBe('light');
    store['ri-theme'] = 'purple';
    expect(readThemePref()).toBe('system');
  });

  it('resolves "system" from the device setting and leaves explicit choices alone', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('survives storage that throws on access', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readThemePref()).toBe('system');
    expect(() => saveThemePref('light')).not.toThrow();
  });
});
