import mongoose from "mongoose";
const { Schema, model } = mongoose;

const ChannelMapSchema = new Schema({
  guildId:   { type: String, required: true, index: true },
  key:       { type: String, required: true },
  channelId: { type: String, required: true },
  note:      { type: String, default: "" }
}, { timestamps: true });

ChannelMapSchema.index({ guildId: 1, key: 1 }, { unique: true });

export const ChannelMapModel = model("ChannelMap", ChannelMapSchema);
