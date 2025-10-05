import mongoose from "mongoose";

const { Schema, model } = mongoose;

const ModerationActionSchema = new Schema({
  guildId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  moderatorId: { type: String, default: null, index: true },
  action: { type: String, required: true, index: true },
  caseNumber: { type: Number, required: true },
  reason: { type: String, default: "No reason provided." },
  durationMs: { type: Number, default: null },
  expiresAt: { type: Date, default: null, index: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
  completedAt: { type: Date, default: null },
  undoContext: { type: Schema.Types.Mixed, default: null },
  expungedAt: { type: Date, default: null },
  expungedBy: { type: String, default: null },
  expungedReason: { type: String, default: null }
}, { timestamps: true });

ModerationActionSchema.index({ guildId: 1, createdAt: -1 });
ModerationActionSchema.index({ guildId: 1, userId: 1, createdAt: -1 });
ModerationActionSchema.index({ guildId: 1, action: 1, createdAt: -1 });
ModerationActionSchema.index({ guildId: 1, caseNumber: 1 }, { unique: true });
ModerationActionSchema.index({ action: 1, completedAt: 1, expiresAt: 1 });
ModerationActionSchema.index({ expungedAt: 1 });

export const ModerationActionModel = model("ModerationAction", ModerationActionSchema);
