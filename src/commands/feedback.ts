import { ChatInputCommandInteraction, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { getFeedback, getStats } from "../services/feedback";
import { getIssues } from "../services/issues";
import { toCsv } from "../services/export";
import { backfillWatchedChannels } from "../services/backfill";
import { parseFeedbackQuery } from "../services/queryParser";
import { THEME_COLORS } from "../utils/theme";

export async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const filter = interaction.options.getString("filter", true);
  const search = interaction.options.getString("search") || undefined;

  await interaction.deferReply({ ephemeral: true });

  try {
    if (filter === "stats") {
      const stats = await getStats(7);
      const embed = new EmbedBuilder()
        .setTitle("📊 Community Feedback Stats (7 days)")
        .setColor(THEME_COLORS.orange)
        .addFields(
          { name: "Total Feedback", value: `${stats.totalFeedback}`, inline: true },
          { name: "Unanswered", value: `${stats.unansweredCount}`, inline: true },
          {
            name: "Top Categories",
            value:
              stats.byCategory
                .slice(0, 5)
                .map((c: { category: string; count: number }) => `${formatCategory(c.category)}: ${c.count}`)
                .join("\n") || "None",
          },
          {
            name: "Sentiment",
            value:
              stats.bySentiment
                .map((s: { sentiment: string; count: number }) => `${s.sentiment}: ${s.count}`)
                .join("\n") || "None",
          }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (filter === "issues") {
      const issues = await getIssues({});
      const open = issues.filter((i: { status: string }) => !["resolved", "ignored"].includes(i.status));
      if (open.length === 0) {
        await interaction.editReply("No open issues right now. 🎉");
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle("🔎 Open Community Issues")
        .setColor(THEME_COLORS.darkOrange)
        .setDescription(
          open
            .slice(0, 10)
            .map(
              (i: { priority: string; title: string; mentionCount: number; uniqueUserIds: string[]; status: string }, idx: number) =>
                `**${idx + 1}. [${i.priority.toUpperCase()}] ${i.title.slice(0, 80)}**\n` +
                `${i.mentionCount} mentions | ${i.uniqueUserIds.length} unique players | status: ${i.status}`
            )
            .join("\n\n")
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (filter === "backfill") {
      await interaction.editReply(
        "Scanning each watched channel for anything new since the last check... this may take a minute, I'll follow up here when done."
      );
      const result = await backfillWatchedChannels(interaction.client);
      const lines = [
        `Backfill complete: ${result.channelsProcessed} channel(s) checked, ${result.scanned} new message(s) scanned.`,
        `Stored as feedback: ${result.stored} (${result.alerted} alerted to Slack)`,
      ];
      if (result.aiErrors > 0) {
        lines.push(`⚠️ ${result.aiErrors} message(s) could not be analyzed due to AI errors -- check ANTHROPIC_API_KEY / ANTHROPIC_MODEL.`);
      }
      if (result.aiDisabled > 0) {
        lines.push(`⚠️ AI analysis is disabled -- ${result.aiDisabled} message(s) were seen but not classified.`);
      }
      await interaction.followUp({ content: lines.join("\n"), ephemeral: true });
      return;
    }

    if (filter === "export") {
      const feedback = await getFeedback({ search, days: 30 });
      if (feedback.length === 0) {
        await interaction.editReply("No feedback to export.");
        return;
      }
      const csv = toCsv(feedback);
      const attachment = new AttachmentBuilder(Buffer.from(csv, "utf-8"), {
        name: `bob-feedback-${new Date().toISOString().split("T")[0]}.csv`,
      });
      await interaction.editReply({
        content: `Exported ${feedback.length} feedback entries (last 30 days).`,
        files: [attachment],
      });
      return;
    }

    const filterMap: Record<string, any> = {
      today: { days: 1 },
      week: { days: 7 },
      bugs: { category: "bug_report" },
      urgent: { urgency: "high" },
      unanswered: { needsReply: "yes" },
    };

    // The search box doubles as a flexible query -- supports things like
    // "category:matchmaking sentiment:negative today" or "from 12:00 to 18:00".
    // Anything it parses (time window, category, sentiment, urgency) overrides
    // the dropdown preset; any leftover words become a plain text search.
    const parsed = parseFeedbackQuery(search);
    const params: any = { ...filterMap[filter] };
    if (parsed.from || parsed.to) {
      delete params.days;
      params.from = parsed.from;
      params.to = parsed.to;
    }
    if (parsed.category) params.category = parsed.category;
    if (parsed.sentiment) params.sentiment = parsed.sentiment;
    if (parsed.urgency) params.urgency = parsed.urgency;
    params.search = parsed.freeText ?? (parsed.category || parsed.sentiment || parsed.urgency || parsed.from ? undefined : search);

    const feedback = await getFeedback(params);

    if (feedback.length === 0) {
      await interaction.editReply("No feedback found for this filter.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`📋 Feedback: ${filter}${search ? ` (search: ${search})` : ""}`)
      .setColor(THEME_COLORS.orange)
      .setDescription(
        feedback
          .slice(0, 10)
          .map(
            (f: { category: string; aiSummary: string | null; content: string; urgency: string; sentiment: string; messageLink: string; suggestedReply: string | null }, i: number) =>
              `**${i + 1}.** [${formatCategory(f.category)}] ${f.aiSummary || f.content.slice(0, 100)}\n` +
              `Urgency: ${f.urgency} | Sentiment: ${f.sentiment} | [Link](${f.messageLink})` +
              (f.suggestedReply ? `\n💬 *Suggested reply:* ${f.suggestedReply.slice(0, 150)}${f.suggestedReply.length > 150 ? "..." : ""}` : "")
          )
          .join("\n\n")
      )
      .setFooter({ text: `Showing ${Math.min(10, feedback.length)} of ${feedback.length} results` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply("Something went wrong fetching feedback.");
  }
}

function formatCategory(category: string): string {
  return category
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
