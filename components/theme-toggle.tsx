"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { toggleTheme } from "@adminoryslabs/design-system/theme";

type Theme = "dark" | "light";

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
};

const getSnapshot = (): Theme =>
  document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";

const getServerSnapshot = (): Theme => "light";

/**
 * Switches the chrome between the light and dark theme. The canvas is exempt:
 * Excalidraw is pinned to the light theme, so a board means the same thing on
 * every monitor regardless of the instructor's or a student's preference.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => toggleTheme()}
      aria-label={label}
      title={label}
    >
      {theme === "dark" ? (
        <Sun size={18} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Moon size={18} strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  );
}
