import mongoose from "mongoose";
const { Schema, model } = mongoose;

const GuildConfigSchema = new Schema({
  guildId: { type: String, required: true, index: true, unique: true },
  modLogChannelId: { type: String },
  autoDeleteCommandSeconds: { type: Number, default: 0 }
}, { timestamps: true });

export const GuildConfigModel = model("GuildConfig", GuildConfigSchema);
