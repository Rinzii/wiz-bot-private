import anyAscii from "any-ascii";

export function isAscii(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  return cp !== undefined && cp < 128;
}

export function isPrintableAscii(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  return cp !== undefined && cp >= 0x21 && cp < 0x7F;
}

export function isValidName(name) {
  if (!name) return false;

  let hasThreePrintable = false;
  let printableRun = 0;
  let firstCharChecked = false;
  let firstCharAscii = false;
  let allAscii = true;

  for (const ch of name) {
    if (!firstCharChecked) {
      firstCharAscii = isAscii(ch);
      firstCharChecked = true;
    }

    const ascii = isAscii(ch);
    if (!ascii) allAscii = false;

    if (isPrintableAscii(ch)) {
      printableRun += 1;
      if (printableRun >= 3) {
        hasThreePrintable = true;
      }
    } else {
      printableRun = 0;
    }
  }

  if (!firstCharChecked) return false;

  return allAscii || firstCharAscii || hasThreePrintable;
}

export function normalizeName(nick, username) {
  const trySources = [nick, username];
  for (const source of trySources) {
    const transliterated = anyAscii(source ?? "");
    const trimmed = transliterated.trim();
    if (trimmed) {
      return trimmed.slice(0, 32);
    }
  }
  return "User";
}

export function hasShouting(nick) {
  if (!nick) return false;
  return /[A-Z]{4,}/.test(nick);
}

export class DisplayNamePolicyService {
  #logger;
  #sweepIntervalMinutes;
  #intervalHandle = null;

  constructor({ logger, sweepIntervalMinutes = 60 } = {}) {
    this.#logger = logger;
    this.#sweepIntervalMinutes = Number.isFinite(sweepIntervalMinutes) && sweepIntervalMinutes > 0
      ? sweepIntervalMinutes
      : 60;
  }

  async onClientReady(client) {
    await this.runFullSweep(client).catch((err) => {
      this.#logger?.error?.("display_name_policy.initial_sweep_failed", { error: String(err?.message || err) });
    });
    this.#scheduleSweep(client);
  }

  async handleMemberJoin(member) {
    await this.#applyPolicies(member, "member_join");
  }

  async handleMemberUpdate(newMember, oldMember) {
    const before = oldMember?.displayName ?? oldMember?.nickname ?? null;
    const after = newMember?.displayName ?? newMember?.nickname ?? null;
    if (before !== after) {
      await this.#applyPolicies(newMember, "member_update");
    }
  }

  async runFullSweep(client) {
    for (const guild of client.guilds.cache.values()) {
      let members;
      try {
        members = await guild.members.fetch();
      } catch (err) {
        this.#logger?.error?.("display_name_policy.sweep_fetch_failed", {
          guildId: guild.id,
          error: String(err?.message || err)
        });
        continue;
      }

      for (const member of members.values()) {
        await this.#applyPolicies(member, "scheduled_sweep");
      }
    }
  }

  async #applyPolicies(member, source) {
    if (!member) return;

    let displayName = member.displayName || member.nickname || member.user?.globalName || member.user?.username || "";

    if (!isValidName(displayName)) {
      const normalized = normalizeName(
        member.nickname ?? displayName,
        member.user?.globalName ?? member.user?.username ?? ""
      );
      const changed = await this.#setNickname(member, normalized, `${source}:normalize`);
      if (changed) {
        displayName = normalized;
      }
    }

    if (hasShouting(displayName)) {
      const lowered = displayName.toLowerCase();
      const changed = await this.#setNickname(member, lowered, `${source}:lowercase`);
      if (changed) {
        displayName = lowered;
      }
    }
  }

  async #setNickname(member, nickname, reasonTag) {
    if (!nickname) return false;

    const current = member.nickname ?? "";
    if (current === nickname) return false;

    if (!member.manageable) {
      this.#logger?.info?.("display_name_policy.unmanageable", {
        guildId: member.guild?.id,
        userId: member.id,
        reason: reasonTag
      });
      return false;
    }

    try {
      await member.setNickname(nickname, "Display name policy enforcement");
      this.#logger?.info?.("display_name_policy.nickname_set", {
        guildId: member.guild?.id,
        userId: member.id,
        nickname,
        reason: reasonTag
      });
      return true;
    } catch (err) {
      this.#logger?.error?.("display_name_policy.nickname_failed", {
        guildId: member.guild?.id,
        userId: member.id,
        reason: reasonTag,
        error: String(err?.message || err)
      });
      return false;
    }
  }

  #scheduleSweep(client) {
    if (this.#intervalHandle) {
      clearInterval(this.#intervalHandle);
    }

    const intervalMs = Math.max(1, Math.floor(this.#sweepIntervalMinutes)) * 60_000;
    const handle = setInterval(() => {
      this.runFullSweep(client).catch((err) => {
        this.#logger?.error?.("display_name_policy.sweep_failed", { error: String(err?.message || err) });
      });
    }, intervalMs);
    handle.unref?.();
    this.#intervalHandle = handle;
  }
}
