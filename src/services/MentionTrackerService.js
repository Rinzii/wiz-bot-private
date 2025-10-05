import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField
} from "discord.js";
import { resolveStaffChannel } from "../utils/staffChannels.js";

const BUTTON_PREFIX = "mention-alert";
const BUTTON_ACTIONS = new Set(["handling", "resolved", "invalid", "nvm"]);
const STAFF_ROLE_KEYS = ["admin", "mod", "special"];

const COLORS = {
  open: 0xf59f00,
  handling: 0x228be6,
  resolved: 0x51cf66,
  invalid: 0xff6b6b
};

export class MentionTrackerService {
  constructor({ logger, channelMapService, staffRoleService, config = {}, fallbackChannelId = "" }) {
    this.logger = logger;
    this.channelMapService = channelMapService;
    this.staffRoleService = staffRoleService;
    this.enabled = Boolean(config?.enabled);
    this.fallbackChannelId = fallbackChannelId || "";
    this.staffFlagChannelKey = config?.staffFlagChannelKey || "";
    this.extraChannelKeys = Array.isArray(config?.additionalFlagChannelKeys)
      ? config.additionalFlagChannelKeys.filter(Boolean)
      : [];
    this.trackedRoleMap = this.#normalizeTargets(config?.trackedRoleIds);
    this.trackedUserMap = this.#normalizeTargets(config?.trackedUserIds);
  }

  #normalizeTargets(value) {
    const map = new Map();
    if (!value) return map;

    const addEntry = (key, raw) => {
      const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
      const ids = list.map((id) => String(id).trim()).filter(Boolean);
      if (!ids.length) return;
      map.set(String(key), new Set(ids));
    };

    if (Array.isArray(value)) {
      addEntry("*", value);
      return map;
    }

    if (typeof value === "object") {
      for (const [key, raw] of Object.entries(value)) {
        addEntry(key, raw);
      }
      return map;
    }

    addEntry("*", value);
    return map;
  }

  #trackedIdsForGuild(map, guildId) {
    const global = map.get("*") || new Set();
    if (!guildId) return new Set(global);
    const guildSpecific = map.get(guildId) || new Set();
    return new Set([...global, ...guildSpecific]);
  }

  #isRoleTracked(guildId, roleId) {
    if (!roleId) return false;
    return this.#trackedIdsForGuild(this.trackedRoleMap, guildId).has(String(roleId));
  }

  #isUserTracked(guildId, userId) {
    if (!userId) return false;
    return this.#trackedIdsForGuild(this.trackedUserMap, guildId).has(String(userId));
  }

  #quoteBlock(text) {
    if (!text) return "> (no text content)";
    const sanitized = text.replace(/\r/g, "\n");
    const lines = sanitized.split(/\n/).slice(0, 10).map((line) => `> ${line}`);
    const joined = lines.join("\n").trim();
    return joined || "> (no text content)";
  }

  #truncate(text, limit) {
    if (!text) return "";
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  #formatStatus(status) {
    switch (status.state) {
      case "handling":
        return `Handling — <@${status.userId}>`;
      case "resolved":
        return `Resolved — <@${status.userId}>`;
      case "invalid":
        return `Invalid — <@${status.userId}>`;
      default:
        return "Open";
    }
  }

  #buildComponents(status) {
    const row = new ActionRowBuilder();
    const disabled = {
      handling: status.state === "handling",
      resolved: status.state === "resolved",
      invalid: status.state === "invalid",
      nvm: status.state === "open"
    };

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}:handling`)
        .setLabel("Handling")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled.handling),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}:resolved`)
        .setLabel("Resolved")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled.resolved),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}:invalid`)
        .setLabel("Invalid")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled.invalid),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}:nvm`)
        .setLabel("nvm")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled.nvm)
    );

    return row;
  }

  #buildEmbed({ message, roles, users, status }) {
    const mentionLines = [];
    const roleMentions = roles.map((role) => `<@&${role.id}>`);
    if (roleMentions.length) {
      mentionLines.push(`Roles: ${roleMentions.join(", ")}`);
    }
    const userMentions = users.map((user) => `<@${user.id}>`);
    if (userMentions.length) {
      mentionLines.push(`Users: ${userMentions.join(", ")}`);
    }

    const mentionValue = mentionLines.join("\n") || "(none)";

    const embed = new EmbedBuilder()
      .setColor(COLORS[status.state] || COLORS.open)
      .setTitle("Tracked mention alert")
      .setDescription([
        `**Mentioner:** <@${message.author.id}> (${message.author.tag})`,
        `**Channel:** <#${message.channelId}>`,
        `[Jump to message](${message.url})`
      ].join("\n"))
      .addFields(
        { name: "Tracked mentions", value: mentionValue, inline: false },
        {
          name: "Message",
          value: this.#truncate(this.#quoteBlock(message.content || message.cleanContent || ""), 1024) || "> (no text content)",
          inline: false
        },
        { name: "Status", value: this.#formatStatus(status), inline: false }
      )
      .setTimestamp(new Date())
      .setFooter({ text: `Message ID: ${message.id}` });

    return embed;
  }

  #parseStatusField(value) {
    if (!value) return { state: "open", userId: null };
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("open")) {
      return { state: "open", userId: null };
    }
    const match = trimmed.match(/^(Handling|Resolved|Invalid)\s+—\s+<@(\d+)>/i);
    if (!match) {
      return { state: "open", userId: null };
    }
    const state = match[1].toLowerCase();
    const userId = match[2] || null;
    return { state, userId };
  }

  #applyAction(current, action, actorId) {
    switch (action) {
      case "handling":
        return { state: "handling", userId: actorId };
      case "resolved":
        return { state: "resolved", userId: actorId };
      case "invalid":
        return { state: "invalid", userId: actorId };
      case "nvm":
        return { state: "open", userId: null };
      default:
        return current;
    }
  }

  async #ensureStaff(interaction) {
    if (!interaction.inGuild()) return false;
    const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) return false;
    if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
    try {
      const staffRoleIds = await this.staffRoleService.getAllRoleIdsForKeys(interaction.guildId, STAFF_ROLE_KEYS);
      return staffRoleIds.some((id) => member.roles?.cache?.has(id));
    } catch {
      return false;
    }
  }

  async handleMessage(message) {
    if (!this.enabled) return;
    if (!message?.guildId || message.author?.bot) return;

    if (message.partial) {
      try {
        await message.fetch();
      } catch (error) {
        this.logger?.warn?.("mention_tracker.fetch_failed", {
          messageId: message.id,
          guildId: message.guildId,
          error: String(error?.message || error)
        });
        return;
      }
    }

    const guildId = message.guildId;
    const trackedRoles = [];
    for (const role of message.mentions?.roles?.values?.() ?? []) {
      if (this.#isRoleTracked(guildId, role.id)) trackedRoles.push(role);
    }
    const trackedUsers = [];
    for (const user of message.mentions?.users?.values?.() ?? []) {
      if (this.#isUserTracked(guildId, user.id)) trackedUsers.push(user);
    }
    const repliedUser = message.mentions?.repliedUser;
    if (repliedUser && this.#isUserTracked(guildId, repliedUser.id) && !trackedUsers.some((u) => u.id === repliedUser.id)) {
      trackedUsers.push(repliedUser);
    }

    if (!trackedRoles.length && !trackedUsers.length) return;

    const keys = [this.staffFlagChannelKey, ...this.extraChannelKeys].filter(Boolean);
    const staffChannel = await resolveStaffChannel(
      message.guild,
      this.channelMapService,
      keys,
      this.fallbackChannelId
    );

    if (!staffChannel) {
      this.logger?.warn?.("mention_tracker.flag_channel_missing", {
        guildId: message.guildId,
        keys,
        fallbackId: this.fallbackChannelId
      });
      return;
    }

    const status = { state: "open", userId: null };
    const embed = this.#buildEmbed({ message, roles: trackedRoles, users: trackedUsers, status });
    const components = this.#buildComponents(status);

    try {
      await staffChannel.send({ embeds: [embed], components: [components] });
      this.logger?.info?.("mention_tracker.alert_sent", {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        roleCount: trackedRoles.length,
        userCount: trackedUsers.length
      });
    } catch (error) {
      this.logger?.warn?.("mention_tracker.alert_failed", {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        error: String(error?.message || error)
      });
    }
  }

  async handleInteraction(interaction) {
    if (!this.enabled) return false;
    if (!interaction.isButton()) return false;
    if (!interaction.customId?.startsWith(`${BUTTON_PREFIX}:`)) return false;

    const [, action] = interaction.customId.split(":");
    if (!BUTTON_ACTIONS.has(action)) return false;

    if (!(await this.#ensureStaff(interaction))) {
      await interaction.reply({ content: "You don’t have permission to update this alert.", ephemeral: true });
      return true;
    }

    const existing = interaction.message?.embeds?.[0];
    if (!existing) {
      await interaction.reply({ content: "Missing alert embed.", ephemeral: true });
      return true;
    }

    const statusFieldIndex = existing.fields?.findIndex((field) => field.name === "Status") ?? -1;
    if (statusFieldIndex === -1) {
      await interaction.reply({ content: "This alert cannot be updated.", ephemeral: true });
      return true;
    }

    const currentStatus = this.#parseStatusField(existing.fields[statusFieldIndex]?.value || "");
    const nextStatus = this.#applyAction(currentStatus, action, interaction.user.id);

    if (currentStatus.state === nextStatus.state && currentStatus.userId === nextStatus.userId) {
      await interaction.reply({ content: "No changes to apply.", ephemeral: true });
      return true;
    }

    const updatedEmbed = EmbedBuilder.from(existing)
      .setColor(COLORS[nextStatus.state] || COLORS.open);

    const fields = [...existing.fields];
    fields[statusFieldIndex] = { ...fields[statusFieldIndex], value: this.#formatStatus(nextStatus) };
    updatedEmbed.setFields(fields);

    const components = this.#buildComponents(nextStatus);

    try {
      await interaction.update({ embeds: [updatedEmbed], components: [components] });
      this.logger?.info?.("mention_tracker.status_updated", {
        guildId: interaction.guildId,
        alertMessageId: interaction.message?.id,
        action,
        actorId: interaction.user.id,
        state: nextStatus.state
      });
    } catch (error) {
      this.logger?.warn?.("mention_tracker.status_update_failed", {
        guildId: interaction.guildId,
        alertMessageId: interaction.message?.id,
        action,
        actorId: interaction.user.id,
        error: String(error?.message || error)
      });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Failed to update the alert.", ephemeral: true }).catch(() => {});
      }
    }

    return true;
  }
}
