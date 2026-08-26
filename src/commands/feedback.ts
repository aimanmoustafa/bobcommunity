import { ChatInputCommandInteraction, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { getFeedback, getStats } from "../services/feedback";
import { getIssues } from "../services/issues";
import { toCsv } from "../services/export";
import { backfillWatchedChannels } from "../services/backfill";
import { parseFeedbackQuery } from "../services/queryParser";
import { isAuthorizedUser } from "../utils/authorization";
import { THEME_COLORS } from "../utils/theme";

function formatCategory(category: string): string {
  return category.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAuthorizedUser(interaction.user.id)) {
    await interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  try {
    if (sub === "stats") {
      const stats = await getStats(7);
      const embed = new EmbedBuilder()
        .setTitle("📊 Feedback Stats (Last 7 Days)")
        .setColor(THEME_COLORS.orange)
        .addFields(
          { name: "Total Feedback", value: String(stats.totalFeedback), inline: true },
          { name: "Unanswered", value: String(stats.unansweredCount), inline: true },
          { name: "Top Categories", value: stats.byCategory.slice(0, 5).map((c: any) => `${formatCategory(c.category)}: ${c.count}`).join("\n") || "none" }
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "issues") {
      const issues = await getIssues();
      const embed = new EmbedBuilder()
        .setTitle("🔧 Tracked Issues")
        .setColor(THEME_COLORS.darkOrange)
        .setDescription(
          issues.length > 0
            ? issues.slice(0, 15).map((i: any) => `**[${i.priority.toUpperCase()}]** ${i.title.slice(0, 80)} -- ${i.mentionCount} mentions (${i.status})`).join("\n")
            : "No open issues."
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "export") {
      const feedback = await getFeedback({ days: 30 });
      const csv = toCsv(feedback as any);
      const file = new AttachmentBuilder(Buffer.from(csv), { name: "feedback-export.csv" });
      await interaction.editReply({ content: "Export ready:", files: [file] });
      return;
    }

    if (sub === "backfill") {
      await interaction.editReply("Backfilling watched channels...");
      const result = await backfillWatchedChannels(interaction.client);
      await interaction.followUp({
        content: `Backfill complete: ${result.scanned} scanned, ${result.stored} stored, ${result.alerted} alerted.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "list") {
      const filter = interaction.options.getString("filter");
      const search = interaction.options.getString("search");
      const parsed = search ? parseFeedbackQuery(search) : {};

      const feedback = await getFeedback({
        category: parsed.category,
        sentiment: parsed.sentiment,
        urgency: parsed.urgency || parsed.priority,
        from: parsed.from,
        to: parsed.to,
        search: parsed.freeText,
        days: filter === "today" ? 1 : filter === "week" ? 7 : undefined,
        needsReply: filter === "unanswered" ? "yes" : undefined,
      });

      const embed = new EmbedBuilder()
        .setTitle("📋 Feedback")
        .setColor(THEME_COLORS.orange)
        .setDescription(
          feedback
            .slice(0, 10)
            .map(
              (f: { category: string; aiSummary: string | null; content: string; urgency: string; sentiment: string; messageLink: string }, i: number) =>
                `**${i + 1}.** [${formatCategory(f.category)}] ${f.aiSummary || f.content.slice(0, 100)}\n` +
                `Urgency: ${f.urgency} | Sentiment: ${f.sentiment} | [Link](${f.messageLink})`
            )
            .join("\n\n") || "No feedback found."
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    await interaction.editReply("Unknown subcommand.");
  } catch (error: any) {
    await interaction.editReply(`Error: ${error?.message || "Unknown error"}`);
  }
}
