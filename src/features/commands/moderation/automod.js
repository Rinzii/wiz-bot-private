import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";
import { TOKENS } from "../../../app/container/index.js";

function buildChoiceOption(option) {
  return option.addStringOption(o => o.setName("state").setDescription("Enable or disable").setRequired(true).addChoices(
    { name: "on", value: "on" },
    { name: "off", value: "off" }
  ));
}

export default {
  data: new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Toggle AutoMod integrations")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => buildChoiceOption(s.setName("invite-block").setDescription("Block Discord invite links")))
    .addSubcommand(s => buildChoiceOption(s.setName("profanity").setDescription("Enable profanity filter"))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Automod", "Guild only.")] });
    }

    const sub = interaction.options.getSubcommand();
    const state = interaction.options.getString("state", true) === "on";
    const runtime = interaction.client.container.get(TOKENS.RuntimeModerationState);
    runtime.setAutomod(interaction.guildId, sub, state);
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Automod", `${sub.replace("-", " ")} is now **${state ? "ENABLED" : "disabled"}**.`)] });
  },
  meta: {
    category: "moderation",
    description: "Toggle Discord AutoMod style features.",
    usage: "/automod invite-block state:on",
    examples: ["/automod profanity state:on"],
    permissions: "Manage Server"
  }
};
