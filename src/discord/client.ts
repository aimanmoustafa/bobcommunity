import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { handleMessage } from "./messageHandler";
import { handleMemberLeave } from "./memberEvents";
import { handleSlashCommand } from "../commands/feedback";
import { handleCommunityCommand } from "../commands/community";

export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers,
      // Thread and forum post messages ride on GuildMessages, but the bot
      // needs to be a member of the thread to receive events from it --
      // handled by the ThreadCreate auto-join listener below.
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  client.once(Events.ClientReady, async (c) => {
    logger.info(`Bot online as ${c.user.tag}`);
    // Register slash commands here (inside the ready handler, attached before
    // login) so there's no race between login resolving and the event firing.
    try {
      await registerCommands(c.user.id);
    } catch (error) {
      logger.error("Failed to register slash commands", error);
    }
  });

  // Auto-join newly created threads and forum posts so the bot can see
  // messages inside them (Discord requires membership to receive events
  // from private threads, and it's good practice for public ones too).
  client.on(Events.ThreadCreate, async (thread) => {
    try {
      if (thread.joinable) {
        await thread.join();
        logger.debug("Joined new thread", { name: thread.name, id: thread.id });
      }
    } catch (error) {
      logger.debug("Could not join thread", error);
    }
  });

  // Listen to every message -- covers regular channels, threads, and
  // forum post threads, since they all emit MessageCreate the same way.
  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleMessage(message);
    } catch (error) {
      logger.error("Error handling message", error);
    }
  });

  // Someone left the server -- try to DM them for exit feedback and log it to Slack
  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      await handleMemberLeave(member);
    } catch (error) {
      logger.error("Error handling member leave", error);
    }
  });

  // Slash commands
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === "community") {
        await handleCommunityCommand(interaction);
      } else {
        await handleSlashCommand(interaction);
      }
    } catch (error) {
      logger.error("Error handling command", error);
    }
  });

  return client;
}

export async function registerCommands(clientId: string): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName("feedback")
      .setDescription("Query community feedback")
      .addStringOption((opt) =>
        opt
          .setName("filter")
          .setDescription("Filter type")
          .setRequired(true)
          .addChoices(
            { name: "Today", value: "today" },
            { name: "This Week", value: "week" },
            { name: "Bugs", value: "bugs" },
            { name: "Urgent", value: "urgent" },
            { name: "Unanswered", value: "unanswered" },
            { name: "Open Issues", value: "issues" },
            { name: "Stats", value: "stats" },
            { name: "Export CSV", value: "export" },
            { name: "Backfill (scan recent history)", value: "backfill" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("search").setDescription("Search term, or a flexible query like \"category:matchmaking sentiment:negative today\"").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("community")
      .setDescription("Quick community intelligence commands")
      .addSubcommand((sub) =>
        sub
          .setName("pulse")
          .setDescription("Quick sentiment/activity snapshot")
          .addIntegerOption((opt) =>
            opt.setName("hours").setDescription("Lookback window in hours (default 6)").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("report")
          .setDescription("Full digest report")
          .addStringOption((opt) =>
            opt
              .setName("period")
              .setDescription("today or week")
              .setRequired(false)
              .addChoices({ name: "Today", value: "today" }, { name: "This Week", value: "week" })
          )
      )
      .addSubcommand((sub) =>
        sub.setName("refresh").setDescription("Scan recent Discord history for anything new")
      ),
  ];

  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  await rest.put(Routes.applicationGuildCommands(clientId, config.discord.guildId), {
    body: commands.map((c) => c.toJSON()),
  });
  logger.info("Slash commands registered");
}
