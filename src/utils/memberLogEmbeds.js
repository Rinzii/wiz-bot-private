import { EmbedBuilder } from "discord.js";
import { formatUserTag, getAvatarUrl } from "./discordUsers.js";

export function createMemberEmbedBase({ member, user, title, color }) {
  const resolvedUser = user ?? member?.user ?? null;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp(new Date());

  const id = member?.id ?? resolvedUser?.id ?? null;
  if (id) embed.setFooter({ text: `ID: ${id}` });

  if (resolvedUser) {
    const avatar = getAvatarUrl(resolvedUser);
    embed.setAuthor({ name: formatUserTag(resolvedUser), iconURL: avatar ?? undefined });
    if (avatar) embed.setThumbnail(avatar);
  }

  return { embed, user: resolvedUser };
}
