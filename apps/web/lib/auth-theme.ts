import type { CSSProperties } from "react";

export type AuthThemeColors = [string, string, string?];

export const authTheme = {
  // Edit --app-color-1/2/3 in packages/ui/src/styles/globals.css
  // to theme auth + app accents from one place.
  defaultColors: [
    "var(--app-color-1)",
    "var(--app-color-2)",
    "var(--app-color-3)",
  ] as AuthThemeColors,
};

export function getAuthThemeVars(
  colors: AuthThemeColors = authTheme.defaultColors,
): CSSProperties {
  const [primary, secondary, tertiary = secondary] = colors;

  return {
    "--auth-color-primary": primary,
    "--auth-color-secondary": secondary,
    "--auth-color-tertiary": tertiary,
  } as CSSProperties;
}
