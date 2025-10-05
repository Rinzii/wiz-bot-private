import { EmbedBuilder } from "discord.js";

export function baseEmbed() {
  return new EmbedBuilder();
}

export function infoEmbed(title, description) {
  return baseEmbed().setTitle(title).setDescription(description ?? "");
}

export function successEmbed(title, description) {
  return baseEmbed().setTitle(title).setDescription(description ?? "");
}

export function errorEmbed(title, description) {
  return baseEmbed().setTitle(title).setDescription(description ?? "");
}

export function listEmbed(title, items, emptyText = "—") {
  const text = (items && items.length) ? items.join("\n") : emptyText;
  return baseEmbed().setTitle(title).setDescription(text);
}
