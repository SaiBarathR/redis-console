import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "rconsole.theme";

/** Stored preference, else the system setting. Only the theme name is stored. */
export function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* Storage is optional. */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme: Theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  if (!persist) return;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* Preferences are optional. */
  }
}

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}
const current = () =>
  (document.documentElement.dataset.theme as Theme | undefined) ?? "light";

/** The active theme; re-renders when the shell switches it (charts read colours from tokens). */
export function useTheme() {
  return useSyncExternalStore(subscribe, current, current);
}

/** Reads a design token from the root element (for canvas drawing such as charts). */
export function token(name: string, fallback = "") {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}
