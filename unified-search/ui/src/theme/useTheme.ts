import { useCallback, useEffect, useState } from 'react';

/**
 * Light or dark, persisted, defaulting to light.
 *
 * The default is light on purpose and does not follow the operating system. This app is
 * used to demonstrate search to a room, and dark backgrounds wash out on a projector, so the
 * scheme should not change depending on whose laptop is plugged in.
 *
 * ## Why `localStorage` here, when tokens are banned from it
 *
 * A theme choice is not a credential. The rule this project enforces is that a **bearer
 * token** never goes to `localStorage`, because anything script-readable turns one
 * compromised dependency into every signed-in user's identity, and because it outlives the
 * tab. Neither applies to a display preference, and persisting it is the point: a presenter
 * sets light mode once, not on every reload.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'unified-search.theme';

/** Reads a stored choice, ignoring anything unrecognised. */
function storedTheme(): Theme | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    // Private browsing modes can throw on access. A theme is not worth failing over.
    return undefined;
  }
}

export interface ThemeState {
  readonly theme: Theme;
  readonly toggle: () => void;
}

export function useTheme(): ThemeState {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? 'light');

  useEffect(() => {
    // The attribute drives the CSS. Set on the root element rather than a wrapper div so it
    // also reaches the page background and native form controls.
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not persisting is a smaller problem than crashing the shell.
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'light' ? 'dark' : 'light'));
  }, []);

  return { theme, toggle };
}
