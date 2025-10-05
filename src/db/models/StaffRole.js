import mongoose from "mongoose";
const { Schema, model } = mongoose;

/** Map guild -> staff role IDs, keyed by label (e.g., "admin", "mod"). */
const StaffRoleSchema = new Schema({
  guildId: { type: String, required: true, index: true },
  key:     { type: String, required: true, index: true },   // "admin", "mod", etc.
  roleId:  { type: String, required: true }
}, { timestamps: true });

StaffRoleSchema.index({ guildId: 1, key: 1, roleId: 1 }, { unique: true });

export const StaffRoleModel = model("StaffRole", StaffRoleSchema);
