import { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { generatePulse, generateDailyReport, generateWeeklyReport } from "../services/feedback";
import { backfillWatchedChannels } from "../services/backfill";

export async function handleCommunityCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  await interaction.deferReply({ ephemeral: true });

  try {
    if (sub === "pulse") {
      const hours = interaction.options.getInteger("hours") || 6;
      const report = await generatePulse(hours);
      const embed = new EmbedBuilder()
        .setTitle("📡 Community Pulse")
        .setColor(0x5865f2)
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
        .setColor(0x5865f2)
        .setDescription(report)
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "refresh") {
      await interaction.editReply(
        "Refreshing: scanning the last 100 messages in each watched channel for anything new..."
      );
      const result = await backfillWatchedChannels(interaction.client);
      await interaction.followUp({
        content: `Refresh complete: scanned ${result.scanned} messages across ${result.channels} channel(s).`,
        ephemeral: true,
      });
      return;
    }

    await interaction.editReply("Unknown subcommand.");
  } catch (error) {
    await interaction.editReply("Something went wrong running that command.");
  }
}
