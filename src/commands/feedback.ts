import { ChatInputCommandInteraction, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { getFeedback, getStats } from "../services/feedback";
import { getIssues } from "../services/issues";
import { toCsv } from "../services/export";

export async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const filter = interaction.options.getString("filter", true);
  const search = interaction.options.getString("search") || undefined;

  await interaction.deferReply({ ephemeral: true });

  try {
    if (filter === "stats") {
      const stats = await getStats(7);
      const embed = new EmbedBuilder()
        .setTitle("📊 Community Feedback Stats (7 days)")
        .setColor(0x5865f2)
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
        .setColor(0xed4245)
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

    const params = { ...filterMap[filter], search };
    const feedback = await getFeedback(params);

    if (feedback.length === 0) {
      await interaction.editReply("No feedback found for this filter.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`📋 Feedback: ${filter}${search ? ` (search: ${search})` : ""}`)
      .setColor(0x5865f2)
      .setDescription(
        feedback
          .slice(0, 10)
          .map(
            (f: { category: string; aiSummary: string | null; content: string; urgency: string; sentiment: string; messageLink: string }, i: number) =>
              `**${i + 1}.** [${formatCategory(f.category)}] ${f.aiSummary || f.content.slice(0, 100)}\n` +
              `Urgency: ${f.urgency} | Sentiment: ${f.sentiment} | [Link](${f.messageLink})`
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
