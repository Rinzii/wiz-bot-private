import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("ban").setDescription("Ban a member")
    .addUserOption(o => o.setName("user").setDescription("User to ban").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Ban", "Guild only.")] });
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Ban", "User not in guild.")] });

    const mod = interaction.client.container.get("ModerationService");
    try {
      await mod.ban(member, reason);
      return interaction.reply({ embeds: [infoEmbed("Ban", `Banned **${user.tag}**\n**Reason:** ${reason}`)] });
    } catch (e) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Ban", `Failed: ${e?.message || e}`)] });
    }
  },
  meta: {
    category: "moderation",
    description: "Ban a member from the server.",
    usage: "/ban user:@User [reason:<text>]",
    examples: ["/ban user:@Spammer reason:raid bot"],
    permissions: "Ban Members"
  }
};
