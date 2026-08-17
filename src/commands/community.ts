import { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { generatePulse, generateDailyReport, generateWeeklyReport } from "../services/feedback";
import { backfillWatchedChannels, scanChannel } from "../services/backfill";
import { assignIssue } from "../services/issues";
import { THEME_COLORS } from "../utils/theme";

export async function handleCommunityCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  await interaction.deferReply({ ephemeral: true });

  try {
    if (sub === "pulse") {
      const hours = interaction.options.getInteger("hours") || 6;
      const report = await generatePulse(hours);
      const embed = new EmbedBuilder()
        .setTitle("📡 Community Pulse")
        .setColor(THEME_COLORS.orange)
        .setDescription(report)
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "report") {
      const period = interaction.options.getString("period") || "today";
      const report = period === "week" ? await generateWeeklyReport() : await generateDailyReport();
      const embed = new EmbedBuilder()
        .setTitle(period === "week" ? "📅 Weekly Community Report" : "📊 Today's Community Report")
        .setColor(THEME_COLORS.orange)
        .setDescription(report)
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "refresh") {
      const window = interaction.options.getString("window");
      const hoursMap: Record<string, number> = { today: hoursSinceMidnight(), last24h: 24, "7d": 168 };
      const hours = window ? hoursMap[window] : undefined;

      await interaction.editReply(
        window
          ? `Refreshing: scanning the last ${window === "today" ? "day" : window} across watched channels...`
          : "Refreshing: checking each watched channel for anything new since the last refresh..."
      );
      const result = await backfillWatchedChannels(interaction.client, { hours });

      const lines = [
        `Refresh complete: ${result.channelsProcessed} channel(s) checked, ${result.scanned} new message(s) scanned.`,
        `Stored as feedback: ${result.stored} (${result.alerted} alerted to Slack)`,
      ];
      if (result.aiErrors > 0) {
        lines.push(`⚠️ ${result.aiErrors} message(s) could not be analyzed due to AI errors -- check ANTHROPIC_API_KEY / ANTHROPIC_MODEL.`);
      }
      if (result.aiDisabled > 0) {
        lines.push(`⚠️ AI analysis is disabled -- ${result.aiDisabled} message(s) were seen but not classified.`);
      }
      if (result.truncatedChannels.length > 0) {
        lines.push(`Note: ${result.truncatedChannels.length} channel(s) hit the scan limit -- run refresh again to continue further back.`);
      }

      await interaction.followUp({ content: lines.join("\n"), ephemeral: true });
      return;
    }

    if (sub === "assign") {
      const search = interaction.options.getString("issue", true);
      const assignee = interaction.options.getString("to", true);
      const flagFollowUp = interaction.options.getBoolean("follow_up") ?? undefined;

      const updated = await assignIssue(search, assignee, flagFollowUp);

      if (!updated) {
        await interaction.editReply(`No open issue found matching "${search}". Try a shorter or different phrase from its title.`);
        return;
      }

      await interaction.editReply(
        `Assigned *"${updated.title.slice(0, 80)}"* to **${assignee}**${updated.followUpFlagged ? " 🚩 (follow-up flagged)" : ""}.`
      );
      return;
    }

    if (sub === "scan") {
      const channel = interaction.options.getChannel("channel", true);
      const window = interaction.options.getString("window");
      const hoursMap: Record<string, number> = { today: hoursSinceMidnight(), last24h: 24, "7d": 168 };
      const hours = window ? hoursMap[window] : undefined;

      await interaction.editReply(
        window
          ? `Scanning #${channel.name}: last ${window === "today" ? "day" : window}...`
          : `Scanning #${channel.name}: most recent messages...`
      );
      const result = await scanChannel(interaction.client, channel.id, { hours });

      const lines = [
        `Scan of #${channel.name} complete: ${result.scanned} message(s) scanned.`,
        `Stored as feedback: ${result.stored} (${result.alerted} alerted to Slack)`,
      ];
      if (result.aiErrors > 0) {
        lines.push(`⚠️ ${result.aiErrors} message(s) could not be analyzed due to AI errors -- check ANTHROPIC_API_KEY / ANTHROPIC_MODEL.`);
      }
      if (result.aiDisabled > 0) {
        lines.push(`⚠️ AI analysis is disabled -- ${result.aiDisabled} message(s) were seen but not classified.`);
      }
      if (result.truncatedChannels.length > 0) {
        lines.push(`Note: this channel hit the scan limit -- run scan again to continue further back.`);
      }

      await interaction.followUp({ content: lines.join("\n"), ephemeral: true });
      return;
    }

    await interaction.editReply("Unknown subcommand.");
  } catch (error) {
    await interaction.editReply("Something went wrong running that command.");
  }
}

function hoursSinceMidnight(): number {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return (now.getTime() - midnight.getTime()) / (60 * 60 * 1000);
}
