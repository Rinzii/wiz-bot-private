import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";

const THREAD_TYPES = [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];

export default {
  data: new SlashCommandBuilder()
    .setName("thread")
    .setDescription("Thread moderation tools")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
    .addSubcommand(s => s
      .setName("lock")
      .setDescription("Lock a thread")
      .addChannelOption(o => o.setName("thread").setDescription("Thread").setRequired(true).addChannelTypes(...THREAD_TYPES)))
    .addSubcommand(s => s
      .setName("archive")
      .setDescription("Archive a thread")
      .addChannelOption(o => o.setName("thread").setDescription("Thread").setRequired(true).addChannelTypes(...THREAD_TYPES))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Thread", "Guild only.")] });
    }

    const sub = interaction.options.getSubcommand();
    const thread = interaction.options.getChannel("thread", true);

    try {
      if (sub === "lock") {
        await thread.setLocked(true, `Locked by ${interaction.user.tag}`);
        return interaction.reply({ embeds: [infoEmbed("Thread", `Locked ${thread}.`)] });
      }
      await thread.setArchived(true, `Archived by ${interaction.user.tag}`);
      return interaction.reply({ embeds: [infoEmbed("Thread", `Archived ${thread}.`)] });
    } catch (err) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Thread", `Failed: ${err?.message || err}`)] });
    }
  },
  meta: {
    category: "moderation",
    description: "Lock or archive threads.",
    usage: "/thread lock thread:<#thread> | /thread archive thread:<#thread>",
    examples: ["/thread lock thread:#support-thread"],
    permissions: "Manage Threads"
  }
};
