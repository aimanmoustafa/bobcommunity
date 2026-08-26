import { ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { generatePulse, generateDailyReport, generateWeeklyReport, generateTopicReport, generateTodoQueue } from "../services/feedback";
import { backfillWatchedChannels, scanChannel } from "../services/backfill";
import { assignIssue, resolveIssueByIdOrSearch, resolveIssueId, searchOpenIssuesForAutocomplete } from "../services/issues";
import { formatIssueForNotionExport, formatIssueRawMessages } from "../services/notionExport";
import { generatePeakTimesReport } from "../services/activity";
import { generateFaqGapReport } from "../services/faqGap";
import { isAuthorizedUser } from "../utils/authorization";
import { THEME_COLORS } from "../utils/theme";

function hoursSinceMidnight(): number {
  const now = new Date();
  return Math.floor((now.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / (60 * 60 * 1000));
}

export async function handleCommunityCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAuthorizedUser(interaction.user.id)) {
    await interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  await interaction.deferReply({ ephemeral: true });

  try {
    if (sub === "peak") {
      const window = (interaction.options.getString("window") || "all") as "24h" | "7d" | "30d" | "all";
      const report = await generatePeakTimesReport(window);
      const embed = new EmbedBuilder()
        .setTitle("📈 Peak Engagement Times")
        .setColor(THEME_COLORS.orange)
        .setDescription(report)
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "topic") {
      const topic = interaction.options.getString("search", true);
      const days = interaction.options.getInteger("days") || 30;
      const report = await generateTopicReport(topic, days);
      const embed = new EmbedBuilder()
        .setTitle(`🔍 Topic: ${topic}`)
        .setColor(THEME_COLORS.orange)
        .setDescription(report.slice(0, 4096))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "todo") {
      const window = interaction.options.getString("window") as "24h" | "7d" | "30d" | null;
      const report = await generateTodoQueue(window || undefined);
      const embed = new EmbedBuilder()
        .setTitle("✅ Your Action Queue")
        .setColor(THEME_COLORS.orange)
        .setDescription(report.slice(0, 4096))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "pulse") {
      const hours = interaction.options.getInteger("hours") || 6;
      const report = await generatePulse(hours);
      const embed = new EmbedBuilder()
        .setTitle("💓 Community Pulse")
        .setColor(THEME_COLORS.orange)
        .setDescription(report.slice(0, 4096))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "report") {
      const period = interaction.options.getString("period") || "today";
      const report = period === "week" ? await generateWeeklyReport() : await generateDailyReport();
      const embed = new EmbedBuilder()
        .setTitle(period === "week" ? "📅 Weekly Report" : "📊 Daily Report")
        .setColor(THEME_COLORS.orange)
        .setDescription(report.slice(0, 4096))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "refresh") {
      const window = interaction.options.getString("window");
      const hoursMap: Record<string, number> = { today: hoursSinceMidnight(), last24h: 24, "7d": 168 };
      const hours = window ? hoursMap[window] : undefined;

      await interaction.editReply(window ? `Refreshing: ${window}...` : "Refreshing since last checkpoint...");
      const result = await backfillWatchedChannels(interaction.client, { hours });

      const lines = [
        `Refresh complete: ${result.scanned} message(s) scanned across ${result.channelsProcessed} channel(s).`,
        `Stored as feedback: ${result.stored} (${result.alerted} alerted to Slack)`,
      ];
      if (result.aiErrors > 0) lines.push(`⚠️ ${result.aiErrors} message(s) could not be analyzed due to AI errors.`);
      if (result.aiDisabled > 0) lines.push(`⚠️ AI analysis is disabled -- ${result.aiDisabled} message(s) were seen but not classified.`);

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

    if (sub === "resolve") {
      const search = interaction.options.getString("issue", true);
      const status = interaction.options.getString("status", true);

      const updated = await resolveIssueByIdOrSearch(search, status);

      if (!updated) {
        await interaction.editReply(`No open issue found matching "${search}". Try a shorter or different phrase from its title.`);
        return;
      }

      await interaction.editReply(`Marked *"${updated.title.slice(0, 80)}"* as **${status}**.`);
      return;
    }

    if (sub === "faqgap") {
      const days = interaction.options.getInteger("days") || 30;
      const report = await generateFaqGapReport(days);
      const embed = new EmbedBuilder()
        .setTitle("📋 FAQ Content Gaps")
        .setColor(THEME_COLORS.orange)
        .setDescription(report.slice(0, 4096))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "notiondata") {
      const search = interaction.options.getString("issue", true);
      const format = interaction.options.getString("format") || "raw";
      const issueId = await resolveIssueId(search);

      if (!issueId) {
        await interaction.editReply(`No open issue found matching "${search}". Try a shorter or different phrase from its title.`);
        return;
      }

      const exportText =
        format === "summary"
          ? await formatIssueForNotionExport(issueId)
          : await formatIssueRawMessages(interaction.client, issueId);

      if (!exportText) {
        await interaction.editReply("Could not generate export for that issue.");
        return;
      }

      const intro =
        format === "summary"
          ? "Clustered summary -- one Notion entry for the whole issue. Paste into a chat with Claude to create it:"
          : "Raw messages -- one block per contributing message, nothing merged or summarized. Paste into a chat with Claude and add an action word (\"log these\", \"just bugs\", \"summarize\"):";

      // Long exports go as a .txt file so nothing gets silently truncated --
      // the whole point is an exact, complete copy-paste, not a preview.
      if (exportText.length > 1900) {
        const file = new AttachmentBuilder(Buffer.from(exportText), { name: format === "summary" ? "notion-export-summary.txt" : "notion-export-raw.txt" });
        await interaction.editReply({ content: `${intro}\n(sent as a file since it's long)`, files: [file] });
      } else {
        await interaction.editReply(`${intro}\n\`\`\`\n${exportText}\n\`\`\``);
      }
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
  } catch (error: any) {
    await interaction.editReply(`Error: ${error?.message || "Unknown error"}`);
  }
}

/**
 * Backs the live-typing dropdown on the "issue" option for both
 * /community assign and /community resolve. Returns up to 25 matching open
 * issues; the value sent back is the issue's real ID, so once someone
 * picks a suggestion, the command handler gets an exact match instead of
 * doing fuzzy title search again.
 */
export async function handleCommunityAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!isAuthorizedUser(interaction.user.id)) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused();
  try {
    const issues = await searchOpenIssuesForAutocomplete(focused, 25);
    await interaction.respond(
      issues.map((i) => ({
        name: `[${i.priority.toUpperCase()}] ${i.title.slice(0, 80)} (${i.mentionCount} mentions)`.slice(0, 100),
        value: i.id,
      }))
    );
  } catch {
    await interaction.respond([]);
  }
}
