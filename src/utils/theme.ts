/**
 * Blitz of Battle brand palette, used consistently across every Discord
 * embed and Slack message the bot sends. Hex strings work directly for
 * both discord.js's EmbedBuilder.setColor() and Slack's attachment
 * "color" field, so one palette serves both platforms.
 */
export const THEME_COLORS = {
  lightOrange: "#FFB347",
  orange: "#FF8C00",
  darkOrange: "#B35900",
} as const;

export type ThemeColor = (typeof THEME_COLORS)[keyof typeof THEME_COLORS];

/**
 * Maps urgency to a shade: critical/high get the more intense colors,
 * medium/low stay light -- keeps the visual severity cue that used to
 * come from red/yellow/green, but within the brand palette.
 */
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
