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

  client.once(Events.ClientReady, (c) => {
    logger.info(`Bot online as ${c.user.tag}`);
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
      await handleSlashCommand(interaction);
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
            { name: "Export CSV", value: "export" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("search").setDescription("Search term").setRequired(false)
      ),
  ];

  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  await rest.put(Routes.applicationGuildCommands(clientId, config.discord.guildId), {
    body: commands.map((c) => c.toJSON()),
  });
  logger.info("Slash commands registered");
}
