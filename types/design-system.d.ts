declare module "@adminoryslabs/design-system/theme-init" {
  const script: string;
  export default script;
}

declare module "@adminoryslabs/design-system/theme" {
  export type Theme = "dark" | "light";
  export type ThemePreference = Theme | "system";

  export function getTheme(): Theme;
  export function setTheme(pref: ThemePreference): void;
  export function toggleTheme(): void;
}
