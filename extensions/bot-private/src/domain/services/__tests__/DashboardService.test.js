import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createServer } from "node:http";
import { DashboardService } from "../DashboardService.js";

const noopModel = {
  aggregate: async () => [],
  countDocuments: async () => 0,
  find: () => ({
    sort: () => ({
      limit: () => ({
        lean: async () => []
      })
    })
  })
};

const createLogger = () => {
  const entries = { info: [], warn: [], error: [] };
  return {
    info(event, payload) {
      entries.info.push({ event, payload });
    },
    warn(event, payload) {
      entries.warn.push({ event, payload });
    },
    error(event, payload) {
      entries.error.push({ event, payload });
    },
    entries
  };
};

const getOpenPort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });

async function createService({ username = "admin", passwordHash, basePath = "/" }) {
  const logger = createLogger();
  const port = await getOpenPort();
  const service = new DashboardService({
    config: {
      enabled: true,
      port,
      basePath,
      username,
      passwordHash,
      sessionSecret: "test-secret",
      secureCookies: false
    },
    logger,
    warningModel: noopModel,
    moderationActionModel: noopModel
  });

  await service.start();

  return { service, logger, port };
}

const login = async (port, { username, password }) => {
  const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

test("dashboard login accepts bcrypt hashed password", async (t) => {
  const hash = await bcrypt.hash("s3cret", 4);
  const { service, port } = await createService({ passwordHash: hash });
  t.after(async () => {
    await service.stop();
  });

  const { status, data } = await login(port, { username: "admin", password: "s3cret" });

  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.username, "admin");
});

test("dashboard login falls back to constant-time comparison when password hash is plain text", async (t) => {
  const { service, port, logger } = await createService({ passwordHash: "plaintext" });
  t.after(async () => {
    await service.stop();
  });

  const { status, data } = await login(port, { username: "admin", password: "plaintext" });

  assert.equal(status, 200);
  assert.equal(data.ok, true);

  const warning = logger.entries.warn.find((entry) => entry.event === "dashboard.password_hash.unhashed");
  assert.ok(warning, "expected plaintext password warning to be logged");
});

test("dashboard exposes a clickable url", async (t) => {
  const hash = await bcrypt.hash("s3cret", 4);
  const basePath = "/control";
  const { service, port } = await createService({ passwordHash: hash, basePath });
  t.after(async () => {
    await service.stop();
  });

  assert.equal(service.getUrl(), `http://localhost:${port}${basePath}`);
});
