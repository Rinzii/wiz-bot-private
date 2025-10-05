import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { decodeSnowflake, formatDiscordTimestamp } from "../../../shared/utils/snowflake.js";

const SNOWFLAKE_PATTERN = /\d+/g;
const TIMESTAMP_STYLE = "F";

function extractCandidates(input) {
  const matches = [];
  if (!input) return matches;
  SNOWFLAKE_PATTERN.lastIndex = 0;
  let match;
  while ((match = SNOWFLAKE_PATTERN.exec(input))) {
    matches.push(match[0]);
  }
  return matches;
}

function renderLine(id) {
  const ts = decodeSnowflake(id);
  if (ts === null) return `${id}: invalid snowflake`;

  const token = formatDiscordTimestamp(ts, TIMESTAMP_STYLE);
  if (!token) return `${id}: invalid snowflake`;
  return `${id}: ${token}`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("snowflake")
    .setDescription("Decode Discord snowflake IDs into timestamps")
    .addStringOption(option =>
      option
        .setName("input")
        .setDescription("Text containing one or more snowflake IDs")
        .setRequired(true)
    ),

  async execute(interaction) {
    const input = interaction.options.getString("input", true);
    const candidates = extractCandidates(input);

    if (!candidates.length) {
      return interaction.reply({
        content: "No snowflake-like IDs found in that input.",
        flags: MessageFlags.Ephemeral
      });
    }

    const lines = candidates.map(renderLine);

    return interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral
    });
  },

  meta: {
    category: "utility",
    description: "Extracts Discord snowflakes from text and shows when they were created.",
    usage: "/snowflake input:<text>",
    examples: [
      "/snowflake input:123456789012345678",
      "/snowflake input:The user joined with id 123456789012345678"
    ]
  }
};
