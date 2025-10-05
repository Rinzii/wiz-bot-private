import mongoose from "mongoose";
const { Schema, model } = mongoose;

const WarningSchema = new Schema({
  guildId: { type: String, required: true, index: true },
  userId:  { type: String, required: true, index: true },
  modId:   { type: String, required: true },
  reason:  { type: String, default: "No reason provided." }
}, { timestamps: true });

WarningSchema.index({ guildId: 1, userId: 1, createdAt: -1 });

export const WarningModel = model("Warning", WarningSchema);
