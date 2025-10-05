import mongoose from "mongoose";
import { ModerationActionModel } from "../db/models/ModerationAction.js";
import { ModerationCounterModel } from "../db/models/ModerationCounter.js";

export class ModerationLogService {
  async record({ guildId, userId, moderatorId, action, reason, durationMs, expiresAt, metadata }) {
    const caseNumber = await this.#nextCaseNumber(guildId);
    const doc = await ModerationActionModel.create({
      guildId,
      userId,
      moderatorId: moderatorId || null,
      action,
      caseNumber,
      reason: reason?.trim?.() || "No reason provided.",
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      expiresAt: expiresAt || null,
      metadata: metadata || {}
    });
    return doc.toObject();
  }

  async markCompleted(id, undoContext = null) {
    return ModerationActionModel.findByIdAndUpdate(
      id,
      { completedAt: new Date(), undoContext },
      { new: true }
    ).lean();
  }

  async getActiveTimedActions(action) {
    return ModerationActionModel.find({
      action,
      completedAt: null,
      expiresAt: { $ne: null },
      expungedAt: null
    }).sort({ expiresAt: 1 }).lean();
  }

  async getById(id) {
    if (!id) return null;
    return ModerationActionModel.findById(id).lean();
  }

  async getByCase(guildId, caseNumber) {
    const numericCase = typeof caseNumber === "number" ? caseNumber : Number(caseNumber);
    if (!guildId || Number.isNaN(numericCase)) return null;
    return ModerationActionModel.findOne({ guildId, caseNumber: numericCase }).lean();
  }

  async findLatestActive({ guildId, userId, action }) {
    if (!guildId || !userId || !action) return null;
    return ModerationActionModel.findOne({
      guildId,
      userId,
      action,
      completedAt: null,
      expungedAt: null
    }).sort({ createdAt: -1 }).lean();
  }

  async findLatestByActions({ guildId, userId, actions, includeExpunged = false }) {
    if (!guildId || !userId || !Array.isArray(actions) || !actions.length) return null;
    const uniqueActions = [...new Set(actions.map(a => (typeof a === "string" ? a.trim() : a)).filter(Boolean))];
    if (!uniqueActions.length) return null;

    const query = { guildId, userId, action: { $in: uniqueActions } };
    if (!includeExpunged) query.expungedAt = null;

    return ModerationActionModel.findOne(query)
      .sort({ createdAt: -1, _id: -1 })
      .lean();
  }

  async list({ guildId, userId, action, limit = 20, beforeId, includeExpunged = false }) {
    if (!guildId) return [];
    const query = { guildId };
    if (userId) query.userId = userId;
    if (action) query.action = action;
    if (!includeExpunged) query.expungedAt = null;
    if (beforeId) {
      try {
        query._id = { $lt: new mongoose.Types.ObjectId(beforeId) };
      } catch {
        // ignore invalid cursors
      }
    }
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return ModerationActionModel.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(safeLimit)
      .lean();
  }

  async expunge({ guildId, caseNumber, moderatorId, reason }) {
    const numericCase = typeof caseNumber === "number" ? caseNumber : Number(caseNumber);
    if (!guildId || Number.isNaN(numericCase)) return null;
    return ModerationActionModel.findOneAndUpdate(
      { guildId, caseNumber: numericCase, expungedAt: null },
      {
        expungedAt: new Date(),
        expungedBy: moderatorId || null,
        expungedReason: reason?.trim?.() || null
      },
      { new: true }
    ).lean();
  }

  async updateReason({ guildId, caseNumber, reason }) {
    const numericCase = typeof caseNumber === "number" ? caseNumber : Number(caseNumber);
    if (!guildId || Number.isNaN(numericCase)) return null;
    return ModerationActionModel.findOneAndUpdate(
      { guildId, caseNumber: numericCase },
      { reason: reason?.trim?.() || "No reason provided." },
      { new: true }
    ).lean();
  }

  async #nextCaseNumber(guildId) {
    if (!guildId) throw new Error("guildId required for case number allocation");
    const counter = await ModerationCounterModel.findOneAndUpdate(
      { guildId },
      { $inc: { lastCaseNumber: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return counter.lastCaseNumber;
  }
}
