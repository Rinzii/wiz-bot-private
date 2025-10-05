import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { TOKENS } from "../../container.js";
import { infoEmbed, listEmbed } from "../../utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("staffroles")
    .setDescription("Map staff roles used for private logging channels")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s =>
      s.setName("add").setDescription("Add a role to a staff key")
       .addStringOption(o => o.setName("key").setDescription("e.g., admin, mod").setRequired(true))
       .addRoleOption(o => o.setName("role").setDescription("Role to add").setRequired(true)))
    .addSubcommand(s =>
      s.setName("remove").setDescription("Remove a role from a staff key")
       .addStringOption(o => o.setName("key").setDescription("e.g., admin, mod").setRequired(true))
       .addRoleOption(o => o.setName("role").setDescription("Role to remove").setRequired(true)))
    .addSubcommand(s => s.setName("list").setDescription("List mapped staff roles"))
    .addSubcommand(s => s.setName("keys").setDescription("List known keys you can assign roles to")),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Staff Roles", "Guild only.")] });
    const svc = interaction.client.container.get(TOKENS.StaffRoleService);
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const key = interaction.options.getString("key", true).toLowerCase();
      const role = interaction.options.getRole("role", true);
      await svc.add(interaction.guildId, key, role.id);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Staff Roles", `Added <@&${role.id}> to **${key}**.`)] });
    }
    if (sub === "remove") {
      const key = interaction.options.getString("key", true).toLowerCase();
      const role = interaction.options.getRole("role", true);
      const ok = await svc.remove(interaction.guildId, key, role.id);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Staff Roles", ok ? `Removed <@&${role.id}> from **${key}**.` : `Nothing to remove.`)] });
    }
    if (sub === "list") {
      const map = await svc.list(interaction.guildId);
      if (!Object.keys(map).length) return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Staff Roles", "No staff roles mapped yet. Use `/staffroles add`.")] });
      const lines = Object.entries(map).map(([k, ids]) => `• **${k}**: ${ids.map(id => `<@&${id}>`).join(", ")}`);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed("Staff Roles", lines)] });
    }
    if (sub === "keys") {
      const keys = await svc.distinctKeys(interaction.guildId);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed("Staff Role Keys", keys.map(k => `• ${k}`), "No keys yet.")] });
    }
  },
  meta: {
    category: "admin",
    description: "Define which roles count as staff (e.g., admin, mod).",
    usage: "/staffroles <add|remove|list|keys> …",
    examples: ["/staffroles add key:admin role:@Admins", "/staffroles keys"],
    permissions: "Administrator"
  }
};
