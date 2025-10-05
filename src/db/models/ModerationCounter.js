import mongoose from "mongoose";

const { Schema, model } = mongoose;

const ModerationCounterSchema = new Schema({
  guildId: { type: String, required: true, unique: true },
  lastCaseNumber: { type: Number, default: 0 }
});

ModerationCounterSchema.index({ guildId: 1 }, { unique: true });

export const ModerationCounterModel = model("ModerationCounter", ModerationCounterSchema);
