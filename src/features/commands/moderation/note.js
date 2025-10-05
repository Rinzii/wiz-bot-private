import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed, listEmbed } from "../../../shared/utils/embeds.js";
import { TOKENS } from "../../../app/container/index.js";

function formatNote(note) {
  const author = note.authorId ? `<@${note.authorId}>` : "Unknown";
  const ts = note.createdAt instanceof Date ? note.createdAt.toISOString() : new Date(note.createdAt).toISOString();
  return `• ${note.text} — ${author} (${ts})`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("note")
    .setDescription("Add or view moderator notes")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(s => s
      .setName("add")
      .setDescription("Add a note for a user")
      .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
      .addStringOption(o => o.setName("text").setDescription("Note text").setRequired(true)))
    .addSubcommand(s => s
      .setName("list")
      .setDescription("List notes for a user")
      .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Note", "Guild only.")] });
    }

    const runtime = interaction.client.container.get(TOKENS.RuntimeModerationState);
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser("user", true);

    if (sub === "add") {
      const text = interaction.options.getString("text", true);
      runtime.addNote(interaction.guildId, user.id, interaction.user.id, text);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Note", `Added note for **${user.tag}**.`)] });
    }

    const notes = runtime.getNotes(interaction.guildId, user.id);
    const lines = notes.map(formatNote);
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed(`Notes for ${user.tag}`, lines, "No notes recorded.")] });
  },
  meta: {
    category: "moderation",
    description: "Maintain informal notes about users.",
    usage: "/note add user:@User text:Spoke to them | /note list user:@User",
    examples: ["/note add user:@Helper text:Great helper"],
    permissions: "Moderate Members"
  }
};
