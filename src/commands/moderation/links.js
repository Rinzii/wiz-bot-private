import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed, listEmbed } from "../../utils/embeds.js";
import { TOKENS } from "../../container.js";

const ruleDescription = (rule) => `• **${rule.type}** — ${rule.value}`;

export default {
  data: new SlashCommandBuilder()
    .setName("links")
    .setDescription("Manage link allow/deny lists")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(g => g
      .setName("allow")
      .setDescription("Allowlist controls")
      .addSubcommand(s => s
        .setName("add")
        .setDescription("Add an allowed link rule")
        .addStringOption(o => o.setName("type").setDescription("Match type").setRequired(true).addChoices(
          { name: "pattern", value: "pattern" },
          { name: "exact", value: "exact" }
        ))
        .addStringOption(o => o.setName("value").setDescription("Value to allow").setRequired(true)))
      .addSubcommand(s => s
        .setName("remove")
        .setDescription("Remove an allowed link rule")
        .addStringOption(o => o.setName("value").setDescription("Value to remove").setRequired(true)))
      .addSubcommand(s => s
        .setName("list")
        .setDescription("List allowed link rules")))
    .addSubcommandGroup(g => g
      .setName("deny")
      .setDescription("Deny list controls")
      .addSubcommand(s => s
        .setName("add")
        .setDescription("Add a denied link rule")
        .addStringOption(o => o.setName("type").setDescription("Match type").setRequired(true).addChoices(
          { name: "pattern", value: "pattern" },
          { name: "exact", value: "exact" }
        ))
        .addStringOption(o => o.setName("value").setDescription("Value to deny").setRequired(true)))
      .addSubcommand(s => s
        .setName("remove")
        .setDescription("Remove a denied link rule")
        .addStringOption(o => o.setName("value").setDescription("Value to remove").setRequired(true)))
      .addSubcommand(s => s
        .setName("list")
        .setDescription("List denied link rules")))
    .addSubcommand(s => s
      .setName("test")
      .setDescription("Test a URL against the rules")
      .addStringOption(o => o.setName("url").setDescription("URL to test").setRequired(true))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Links", "Guild only.")] });
    }

    const runtime = interaction.client.container.get(TOKENS.RuntimeModerationState);
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (!group) {
      const url = interaction.options.getString("url", true);
      const result = runtime.testLink(interaction.guildId, url);
      const resText = result.result === "none" ? "No rules matched." : `Matched **${result.result}** (${result.rule?.type ?? "?"} → ${result.rule?.value ?? ""}).`;
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Links Test", resText)] });
    }

    const kind = group;
    if (sub === "add") {
      const type = interaction.options.getString("type", true) === "exact" ? "exact" : "pattern";
      const value = interaction.options.getString("value", true);
      runtime.addLinkRule(interaction.guildId, kind, { type, value });
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Links", `${kind === "allow" ? "Allow" : "Deny"} rule added for **${value}** (${type}).`)] });
    }
    if (sub === "remove") {
      const value = interaction.options.getString("value", true);
      const removed = runtime.removeLinkRule(interaction.guildId, kind, value);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Links", removed ? `Removed ${kind} rule for **${value}**.` : "No matching rule.")] });
    }
    const rules = runtime.listLinkRules(interaction.guildId, kind).map(ruleDescription);
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed(`${kind === "allow" ? "Allowed" : "Denied"} links`, rules)] });
  },
  meta: {
    category: "moderation",
    description: "Manage link allow/deny rules.",
    usage: "/links allow add type:pattern value:example.com",
    examples: ["/links allow list", "/links deny add type:exact value:bad.com"],
    permissions: "Manage Server"
  }
};
