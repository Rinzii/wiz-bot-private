import crypto from "node:crypto";
import bcrypt from "bcrypt";

const BCRYPT_REGEX = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export function timingSafeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  const len = Math.max(bufferA.length, bufferB.length, 1);
  const paddedA = Buffer.alloc(len);
  const paddedB = Buffer.alloc(len);
  bufferA.copy(paddedA);
  bufferB.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && bufferA.length === bufferB.length;
}

export function looksLikeBcryptHash(value) {
  return typeof value === "string" && BCRYPT_REGEX.test(value);
}

export function createPasswordVerifier({ bcryptModule = bcrypt } = {}) {
  const compareWithBcrypt = async (candidate, hash) => {
    if (!bcryptModule || typeof bcryptModule.compare !== "function") {
      return { ok: false, error: new Error("bcrypt_compare_unavailable") };
    }
    try {
      const ok = await bcryptModule.compare(candidate, hash);
      return { ok: Boolean(ok), error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  };

  return {
    looksHashed: looksLikeBcryptHash,
    async verify({ secret, provided, onPlaintextFallback } = {}) {
      if (typeof provided !== "string" || typeof secret !== "string" || !secret) {
        return { ok: false, hashed: false, error: null };
      }

      if (looksLikeBcryptHash(secret)) {
        const result = await compareWithBcrypt(provided, secret);
        return { ok: result.ok, hashed: true, error: result.error };
      }

      if (typeof onPlaintextFallback === "function") {
        onPlaintextFallback();
      }

      return { ok: timingSafeCompare(provided, secret), hashed: false, error: null };
    }
  };
}
