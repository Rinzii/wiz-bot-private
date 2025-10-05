import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("getMemberLogColors merges config overrides with fallbacks", async () => {
  const url = new URL("../../../../src/shared/utils/memberLog.js", import.meta.url);
  const source = await readFile(url, "utf8");
  const patched = source.replace(
    'import { CONFIG } from "../../config/index.js";',
    'const CONFIG = { colors: { green: 0x010203, default: 0x0a0b0c } };'
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(patched).toString("base64")}`;
  const { getMemberLogColors } = await import(moduleUrl);
  assert.deepEqual(getMemberLogColors(), {
    join: 0x010203,
    leave: 0xED4245,
    neutral: 0x0a0b0c
  });
});
