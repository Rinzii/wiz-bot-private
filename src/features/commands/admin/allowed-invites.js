import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags, EmbedBuilder } from "discord.js";
import { TOKENS } from "../../../app/container/index.js";
import { extractInviteCode } from "../../../shared/utils/invites.js";
import { infoEmbed, listEmbed, errorEmbed } from "../../../shared/utils/embeds.js";

function buildInviteEmbed(invite, code) {
  const embed = new EmbedBuilder()
    .setTitle(invite.guild?.name || "Unknown Guild")
    .setDescription(`[discord.gg/${code}](https://discord.gg/${code})`)
    .setFooter({ text: `Code: ${code}` });
  if (invite.guild?.iconURL?.()) embed.setThumbnail(invite.guild.iconURL({ size: 128 }));
  return embed;
}

export default {
  data: new SlashCommandBuilder()
    .setName("allowed-invites")
    .setDescription("Manage allowed Discord invite codes")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Allow a Discord invite code")
        .addStringOption((opt) => opt.setName("code").setDescription("Invite code or URL").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove an allowed invite code")
        .addStringOption((opt) => opt.setName("code").setDescription("Invite code or URL").setRequired(true))
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List allowed invite codes")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Allowed Invites", "This command can only be used in a server.")]
      });
    }

    const sub = interaction.options.getSubcommand();
    const service = interaction.client.container.get(TOKENS.AllowedInviteService);

    if (sub === "add") {
      const rawInput = interaction.options.getString("code", true);
      const code = extractInviteCode(rawInput);
      if (!code) {
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [errorEmbed("Allowed Invites", "Unable to determine invite code from input.")]
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let invite;
      try {
        invite = await interaction.client.fetchInvite(code);
      } catch (err) {
        return interaction.editReply({
          embeds: [errorEmbed("Allowed Invites", `Failed to fetch invite: ${err?.message || err}`)]
        });
      }

      if (!invite?.guild) {
        return interaction.editReply({
          embeds: [errorEmbed("Allowed Invites", "Invite is not associated with a guild.")]
        });
      }

      if (invite.expiresTimestamp || (typeof invite.maxAge === "number" && invite.maxAge > 0)) {
        return interaction.editReply({
          embeds: [errorEmbed("Allowed Invites", "Invite must be non-expiring.")]
        });
      }

      if (invite.temporary) {
        return interaction.editReply({
          embeds: [errorEmbed("Allowed Invites", "Temporary invites cannot be allowlisted.")]
        });
      }

      const record = {
        code: invite.code || code,
        url: `https://discord.gg/${invite.code || code}`,
        guildId: invite.guild.id,
        guildName: invite.guild.name,
        iconUrl: invite.guild.iconURL({ size: 256 }) || null,
        addedBy: interaction.user.id
      };

      try {
        await service.add(record);
      } catch (err) {
        return interaction.editReply({
          embeds: [errorEmbed("Allowed Invites", `Failed to save invite: ${err?.message || err}`)]
        });
      }

      return interaction.editReply({
        content: `Allowlisted invite \`${record.code}\`.`,
        embeds: [buildInviteEmbed(invite, record.code)]
      });
    }

    if (sub === "remove") {
      const rawInput = interaction.options.getString("code", true);
      const code = extractInviteCode(rawInput);
      if (!code) {
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [errorEmbed("Allowed Invites", "Unable to determine invite code from input.")]
        });
      }

      try {
        const removed = await service.remove(code);
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [infoEmbed("Allowed Invites", removed ? `Removed \`${code}\`.` : `No allowlist entry for \`${code}\`.`)]
        });
      } catch (err) {
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [errorEmbed("Allowed Invites", `Failed to remove invite: ${err?.message || err}`)]
        });
      }
    }

    if (sub === "list") {
      const entries = service.list();
      if (!entries.length) {
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [infoEmbed("Allowed Invites", "No invite codes are allowlisted.")]
        });
      }
      const lines = entries.map((entry) => `• [${entry.code}](https://discord.gg/${entry.code}) — ${entry.guildName}`);
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [listEmbed("Allowed Invite Codes", lines)]
      });
    }
  },
  meta: {
    category: "admin",
    description: "Manage trusted Discord invite codes for invite filtering.",
    usage: "/allowed-invites <add|remove|list>",
    examples: [
      "/allowed-invites add code:https://discord.gg/example",
      "/allowed-invites remove code:example",
      "/allowed-invites list"
    ],
    permissions: "Administrator"
  }
};
