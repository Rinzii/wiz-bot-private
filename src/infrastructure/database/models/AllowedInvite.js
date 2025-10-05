import mongoose from "mongoose";
const { Schema, model } = mongoose;

const AllowedInviteSchema = new Schema({
  code: { type: String, required: true },
  codeLower: { type: String, required: true, unique: true, index: true },
  url: { type: String, required: true },
  guildId: { type: String, required: true },
  guildName: { type: String, required: true },
  iconUrl: { type: String },
  addedBy: { type: String }
}, { timestamps: true });

AllowedInviteSchema.pre("validate", function(next) {
  if (this.code) this.code = String(this.code);
  if (this.code) this.codeLower = this.code.toLowerCase();
  if (!this.codeLower && this.code) this.codeLower = this.code.toLowerCase();
  next();
});

AllowedInviteSchema.pre("findOneAndUpdate", function(next) {
  const update = this.getUpdate();
  if (!update) return next();
  const set = update.$set || update;
  if (set.code) {
    set.codeLower = String(set.code).toLowerCase();
    update.$set = set;
  }
  next();
});

export const AllowedInviteModel = model("AllowedInvite", AllowedInviteSchema);
