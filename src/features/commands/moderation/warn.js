import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { TOKENS } from "../../../app/container/index.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("warn").setDescription("Add a warning to a user")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Warn", "Guild only.")] });
    const target = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const svc = interaction.client.container.get(TOKENS.WarningService);
    await svc.add(interaction.guildId, target.id, interaction.user.id, reason);
    return interaction.reply({ embeds: [infoEmbed("Warn", `Warned **${target.tag}**\n**Reason:** ${reason}`)] });
  },
  meta: {
    category: "moderation",
    description: "Record a warning for a user.",
    usage: "/warn user:@User [reason:<text>]",
    examples: ["/warn user:@User reason:spam"],
    permissions: "Timeout Members (or Moderator role)"
  }
};
