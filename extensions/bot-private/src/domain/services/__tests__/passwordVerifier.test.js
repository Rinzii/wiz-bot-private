import test from "node:test";
import assert from "node:assert/strict";
import { createPasswordVerifier, looksLikeBcryptHash, timingSafeCompare } from "../passwordVerifier.js";

const HASH = "$2b$04$O5oQx1YgnPZXoqBYwygJyOqyDlITZTUA3Vv666ZOs4j23t1dIzkwO"; // hash for "secret"

test("looksLikeBcryptHash detects valid bcrypt hashes", () => {
  assert.equal(looksLikeBcryptHash(HASH), true);
  assert.equal(looksLikeBcryptHash("not-a-hash"), false);
  assert.equal(looksLikeBcryptHash(123), false);
});

test("timingSafeCompare performs constant-time comparison", () => {
  assert.equal(timingSafeCompare("abc", "abc"), true);
  assert.equal(timingSafeCompare("abc", "abd"), false);
  assert.equal(timingSafeCompare("abc", ""), false);
});

test("createPasswordVerifier compares bcrypt hashes when available", async () => {
  const verifier = createPasswordVerifier({
    bcryptModule: {
      compare: async (candidate, hash) => candidate === "secret" && hash === HASH
    }
  });

  const ok = await verifier.verify({ provided: "secret", secret: HASH });
  assert.deepEqual(ok, { ok: true, hashed: true, error: null });

  const fail = await verifier.verify({ provided: "nope", secret: HASH });
  assert.deepEqual(fail, { ok: false, hashed: true, error: null });
});

test("createPasswordVerifier falls back to timing safe compare for plaintext", async () => {
  let warned = false;
  const verifier = createPasswordVerifier({
    bcryptModule: {
      compare: () => {
        throw new Error("should not be called for plaintext");
      }
    }
  });

  const result = await verifier.verify({
    provided: "secret",
    secret: "secret",
    onPlaintextFallback: () => {
      warned = true;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.hashed, false);
  assert.equal(result.error, null);
  assert.equal(warned, true);
});

test("createPasswordVerifier exposes bcrypt errors", async () => {
  const error = new Error("boom");
  const verifier = createPasswordVerifier({
    bcryptModule: {
      compare: () => {
        throw error;
      }
    }
  });

  const result = await verifier.verify({ provided: "secret", secret: HASH });
  assert.equal(result.ok, false);
  assert.equal(result.hashed, true);
  assert.equal(result.error, error);
});
