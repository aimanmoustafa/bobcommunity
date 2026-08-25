export const THEME_COLORS = {
  lightOrange: "#FFB347",
  orange: "#FF8C00",
  darkOrange: "#B35900",
} as const;

export type ThemeColor = (typeof THEME_COLORS)[keyof typeof THEME_COLORS];

export function urgencyThemeColor(urgency: string): ThemeColor {
  switch (urgency) {
    case "critical":
      return THEME_COLORS.darkOrange;
    case "high":
      return THEME_COLORS.orange;
    default:
      return THEME_COLORS.lightOrange;
  }
}
