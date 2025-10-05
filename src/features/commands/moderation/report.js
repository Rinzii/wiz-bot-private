import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from "discord.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";
import { TOKENS } from "../../../app/container/index.js";

export default {
  data: new SlashCommandBuilder()
    .setName("report")
    .setDescription("Report a user to the moderation team")
    .addUserOption(o => o.setName("user").setDescription("User to report").setRequired(true))
    .addStringOption(o => o.setName("text").setDescription("Details").setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Report", "Use this command in a server.")] });
    }

    const target = interaction.options.getUser("user", true);
    const text = interaction.options.getString("text", true);
    const guildConfigService = interaction.client.container.get(TOKENS.GuildConfigService);
    const channelId = await guildConfigService.getModLogChannelId(interaction.guildId);

    if (channelId) {
      const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased?.()) {
        const embed = new EmbedBuilder()
          .setTitle("User Report")
          .setDescription(text)
          .addFields(
            { name: "Reporter", value: `${interaction.user.tag} (${interaction.user.id})` },
            { name: "Reported", value: `${target.tag} (${target.id})` }
          )
          .setTimestamp(new Date());
        await channel.send({ embeds: [embed] }).catch(() => {});
      }
    }

    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Report", "Thanks, your report has been submitted to the moderators.")] });
  },
  meta: {
    category: "utility",
    description: "Send a report for staff review.",
    usage: "/report user:@User text:<details>",
    examples: ["/report user:@Trouble text:Spamming slurs"],
    permissions: "Everyone"
  }
};
