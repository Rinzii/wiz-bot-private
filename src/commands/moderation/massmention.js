import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";
import { TOKENS } from "../../container.js";

export default {
  data: new SlashCommandBuilder()
    .setName("massmention")
    .setDescription("Configure mass mention limit")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(g => g
      .setName("limit")
      .setDescription("Limit settings")
      .addSubcommand(s => s
        .setName("set")
        .setDescription("Set mention limit")
        .addIntegerOption(o => o.setName("count").setDescription("Mentions per message").setRequired(true).setMinValue(1)))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Massmention", "Guild only.")] });
    }

    const limit = interaction.options.getInteger("count", true);
    const runtime = interaction.client.container.get(TOKENS.RuntimeModerationState);
    runtime.setMassMentionLimit(interaction.guildId, limit);
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Massmention", `Limit set to **${limit}** mentions per message.`)] });
  },
  meta: {
    category: "moderation",
    description: "Limit how many users can be mentioned per message.",
    usage: "/massmention limit set count:5",
    examples: ["/massmention limit set count:3"],
    permissions: "Manage Server"
  }
};
