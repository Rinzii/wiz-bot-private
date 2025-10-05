import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";

function findQuarantineRole(guild) {
  const byName = guild.roles.cache.find(r => /quarantine|restricted/i.test(r.name));
  return byName || null;
}

export default {
  data: new SlashCommandBuilder()
    .setName("quarantine")
    .setDescription("Move a member into a restricted role")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Quarantine", "Guild only.")] });
    }

    const target = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "Quarantined";
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Quarantine", "User not found in guild.")] });
    }

    const role = findQuarantineRole(interaction.guild);
    if (!role) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Quarantine", "No quarantine/restricted role found.")] });
    }

    try {
      await member.roles.add(role, `${reason} (by ${interaction.user.tag})`);
      return interaction.reply({ embeds: [infoEmbed("Quarantine", `Assigned **${role.name}** to **${target.tag}**.`)] });
    } catch (err) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Quarantine", `Failed: ${err?.message || err}`)] });
    }
  },
  meta: {
    category: "moderation",
    description: "Assign a restricted role to a member.",
    usage: "/quarantine user:@User [reason:<text>]",
    examples: ["/quarantine user:@Trouble reason:Spamming invites"],
    permissions: "Manage Roles"
  }
};
