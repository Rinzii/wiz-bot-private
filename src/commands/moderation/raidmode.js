import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";
import { TOKENS } from "../../container.js";

export default {
  data: new SlashCommandBuilder()
    .setName("raidmode")
    .setDescription("Toggle hardened raid mode")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName("state").setDescription("on or off").setRequired(true).addChoices(
      { name: "on", value: "on" },
      { name: "off", value: "off" }
    )),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Raidmode", "Guild only.")] });
    }

    const state = interaction.options.getString("state", true) === "on";
    const runtime = interaction.client.container.get(TOKENS.RuntimeModerationState);
    runtime.setRaidMode(interaction.guildId, state);
    return interaction.reply({ embeds: [infoEmbed("Raidmode", `Raidmode is now **${state ? "ON" : "OFF"}**.`)] });
  },
  meta: {
    category: "security",
    description: "Toggle raid hardening mode.",
    usage: "/raidmode on|off",
    examples: ["/raidmode on"],
    permissions: "Manage Server"
  }
};
