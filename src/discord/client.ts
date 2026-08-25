import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
} from "discord.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { handleMessage } from "./messageHandler";
import { handleExitDmReply } from "./exitReplyHandler";
import { handleMemberJoin, handleMemberLeave } from "./memberEvents";
import { handleSlashCommand } from "../commands/feedback";
import { handleCommunityCommand } from "../commands/community";

export function createClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers,
      // Required to receive DM replies from departed members (exit-feedback
      // reply tracking) -- without this, message content in DMs is invisible.
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember],
  });

  client.once(Events.ClientReady, async () => {
    logger.info(`Bot online as ${client.user?.tag}`);
    await registerCommands(client);
    logStartupDiagnostic(client);
  });

  // Listen to every message -- covers regular channels, threads, and
  // forum post threads, since they all emit MessageCreate the same way.
  // DMs (no guild) route separately, since a reply to the exit-feedback
  // DM should be forwarded, not run through the community-feedback pipeline.
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!message.guild) {
        await handleExitDmReply(message);
      } else {
        await handleMessage(message);
      }
    } catch (error) {
      logger.error("Error handling message", error);
    }
  });

  // Someone joined the server -- send a welcome DM. Its real purpose is
  // opening a DM channel while the bot and this person clearly share a
  // server, so the exit-feedback DM later has an actual chance of landing.
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      await handleMemberJoin(member);
    } catch (error) {
      logger.error("Error handling member join", error);
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

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "feedback") {
          await handleSlashCommand(interaction);
        } else if (interaction.commandName === "community") {
          await handleCommunityCommand(interaction);
        }
      }
    } catch (error) {
      logger.error("Error handling interaction", error);
    }
  });

  return client;
}

async function registerCommands(client: Client): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName("feedback")
      .setDescription("Search and manage community feedback")
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("List feedback with optional filters")
          .addStringOption((opt) => opt.setName("filter").setDescription("today | week | bugs | urgent | unanswered | open_issues"))
          .addStringOption((opt) => opt.setName("search").setDescription("Flexible search: category:x sentiment:y today, from 12:00 to 18:00, etc."))
      )
      .addSubcommand((sub) => sub.setName("stats").setDescription("Show feedback statistics"))
      .addSubcommand((sub) => sub.setName("issues").setDescription("Show tracked issues"))
      .addSubcommand((sub) => sub.setName("export").setDescription("Export feedback to CSV/JSON"))
      .addSubcommand((sub) => sub.setName("backfill").setDescription("Scan channel history for missed feedback")),
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
          .setName("peak")
          .setDescription("Find peak engagement times -- best time to run an event")
          .addStringOption((opt) =>
            opt
              .setName("window")
              .setDescription("Time period to analyze (default: all-time)")
              .setRequired(false)
              .addChoices(
                { name: "Last 24 hours", value: "24h" },
                { name: "Last 7 days", value: "7d" },
                { name: "Last 30 days", value: "30d" },
                { name: "All-time", value: "all" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("topic")
          .setDescription("Everything mentioning a specific hero, feature, or keyword")
          .addStringOption((opt) =>
            opt.setName("search").setDescription("Hero, feature, or keyword to search for").setRequired(true)
          )
          .addIntegerOption((opt) =>
            opt.setName("days").setDescription("Lookback window in days (default 30)").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("todo")
          .setDescription("Your personal action queue: needs-reply items + flagged follow-ups")
          .addStringOption((opt) =>
            opt
              .setName("window")
              .setDescription("Scope to a recent period (default: all time)")
              .setRequired(false)
              .addChoices(
                { name: "Last 24 hours", value: "24h" },
                { name: "Last 7 days", value: "7d" },
                { name: "Last 30 days", value: "30d" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("report")
          .setDescription("Run the daily or weekly digest on demand")
          .addStringOption((opt) =>
            opt
              .setName("period")
              .setDescription("today or week")
              .setRequired(false)
              .addChoices({ name: "Today", value: "today" }, { name: "This Week", value: "week" })
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("refresh")
          .setDescription("Scan recent Discord history for anything new")
          .addStringOption((opt) =>
            opt
              .setName("window")
              .setDescription("Force a specific lookback instead of since-last-refresh")
              .setRequired(false)
              .addChoices(
                { name: "Today", value: "today" },
                { name: "Last 24 hours", value: "last24h" },
                { name: "Last 7 days", value: "7d" }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("assign")
          .setDescription("Assign an open issue to someone, optionally flagging it for follow-up")
          .addStringOption((opt) =>
            opt.setName("issue").setDescription("Part of the issue's title to match").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("to").setDescription("Who it's assigned to").setRequired(true)
          )
          .addBooleanOption((opt) =>
            opt.setName("follow_up").setDescription("Flag for follow-up").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("scan")
          .setDescription("Manually scan any channel, even ones not in the regular watch list")
          .addChannelOption((opt) =>
            opt
              .setName("channel")
              .setDescription("The channel to scan")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.GuildForum,
                ChannelType.PublicThread,
                ChannelType.PrivateThread,
                ChannelType.AnnouncementThread
              )
          )
          .addStringOption((opt) =>
            opt
              .setName("window")
              .setDescription("How far back to look (default: just the most recent messages)")
              .setRequired(false)
              .addChoices(
                { name: "Today", value: "today" },
                { name: "Last 24 hours", value: "last24h" },
                { name: "Last 7 days", value: "7d" }
              )
          )
      ),
  ];

  const rest = new REST().setToken(config.discord.token);
  await rest.put(Routes.applicationGuildCommands(client.user!.id, config.discord.guildId), { body: commands });
  logger.info("Slash commands registered");
}

function logStartupDiagnostic(client: Client): void {
  logger.info("===== BoB Community Bot: Startup Diagnostic =====");
  logger.info(`AI Provider: ${config.ai.provider}`);
  logger.info(`AI Model: ${config.ai.model}`);
  logger.info(`API Key: ${config.ai.apiKey ? "Configured" : "MISSING"}`);
  logger.info(`Discord: Connected`);
  logger.info(`Watched Channels: ${config.discord.watchedChannelIds.length}`);
  logger.info(`AI Analysis: ${config.ai.apiKey ? "Enabled" : "Disabled"}`);
  logger.info("==================================================");
}
