import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed, listEmbed } from "../../utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("channelmap")
    .setDescription("Manage channel mappings by purpose")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s =>
      s.setName("set").setDescription("Set a channel for a purpose key")
       .addStringOption(o => o.setName("key").setDescription("Purpose key (e.g., bot_log)").setRequired(true))
       .addChannelOption(o => o
         .setName("channel")
         .setDescription("Channel to map")
         .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
         .setRequired(true))
       .addStringOption(o => o.setName("note").setDescription("Optional note")))
    .addSubcommand(s =>
      s.setName("get").setDescription("Get a channel mapping")
       .addStringOption(o => o.setName("key").setDescription("Purpose key").setRequired(true)))
    .addSubcommand(s =>
      s.setName("remove").setDescription("Remove a mapping")
       .addStringOption(o => o.setName("key").setDescription("Purpose key").setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("List all mappings")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Channel Map", "Guild only.")] });
    }
    const svc = interaction.client.container.get("ChannelMapService");
    const sub = interaction.options.getSubcommand();

    if (sub === "set") {
      const key = interaction.options.getString("key", true);
      const ch = interaction.options.getChannel("channel", true);
      const note = interaction.options.getString("note") || "";
      await svc.set(interaction.guildId, key, ch.id, note);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Channel Map Updated", `**${key}** → <#${ch.id}>`)] });
    }
    if (sub === "get") {
      const key = interaction.options.getString("key", true);
      const m = await svc.get(interaction.guildId, key);
      const text = m ? `**${key}** → <#${m.channelId}> ${m.note ? `— ${m.note}` : ""}` : `No mapping for **${key}**.`;
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Channel Map", text)] });
    }
    if (sub === "remove") {
      const key = interaction.options.getString("key", true);
      const ok = await svc.remove(interaction.guildId, key);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Channel Map", ok ? `Removed **${key}**.` : `No mapping for **${key}**.`)] });
    }
    if (sub === "list") {
      const rows = await svc.list(interaction.guildId);
      const lines = rows.map(r => `• **${r.key}** → <#${r.channelId}> ${r.note ? `— ${r.note}` : ""}`);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed("Channel Map", lines, "No mappings yet.")] });
    }
  },
  meta: {
    category: "admin",
    description: "Create, inspect, and remove channel purpose mappings.",
    usage: "/channelmap <set|get|remove|list> …",
    examples: ["/channelmap set key:bot_log channel:#bot-log", "/channelmap list"],
    permissions: "Administrator"
  }
};
