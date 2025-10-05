import { test } from "node:test";
import assert from "node:assert/strict";
import { Container, TOKENS } from "../../../src/app/container/index.js";
import { registerCoreServices } from "../../../src/app/container/registerCoreServices.js";

function createLoggerStub() {
  const infoCalls = [];
  const errorCalls = [];
  return {
    infoCalls,
    errorCalls,
    info: (...args) => { infoCalls.push(args); },
    error: (...args) => { errorCalls.push(args); },
    setMirror: () => {}
  };
}

function createBaseOverrides(overrides = {}) {
  return {
    logger: createLoggerStub(),
    moderationLogService: {},
    warningService: {},
    moderationService: { setClient: () => {} },
    channelMapService: {},
    staffRoleService: {},
    guildConfigService: { getModLogChannelId: async () => null },
    antiSpamService: {},
    runtimeModerationState: {},
    staffMemberLogService: {},
    virusTotalService: {},
    mentionTrackerService: {},
    displayNamePolicyService: {},
    allowedInviteService: { loadAll: async () => 0 },
    ...overrides
  };
}

test("registerCoreServices registers provided overrides and preloads invites", async () => {
  const container = new Container();
  let loadCount = 0;
  const overrides = createBaseOverrides({
    allowedInviteService: {
      loadAll: async () => {
        loadCount += 1;
        return 2;
      }
    }
  });

  const config = {
    debugChannelId: "123",
    logLevel: "info",
    channels: { staffMemberLogId: "staff" },
    modLogChannelId: "mod",
    displayNamePolicy: { sweepIntervalMinutes: 30 }
  };

  const result = await registerCoreServices({ container, config, services: overrides });
  assert.equal(loadCount, 1);
  assert.equal(container.get(TOKENS.Logger), overrides.logger);
  assert.equal(container.get(TOKENS.AllowedInviteService), overrides.allowedInviteService);
  assert.equal(result.logger, overrides.logger);
  assert.equal(result.allowedInviteService, overrides.allowedInviteService);
  assert.equal(result.debugState.channelId, "123");
  assert.deepEqual(overrides.logger.infoCalls[0], ["invite_guard.allowlist_preload", { count: 2 }]);
});

test("registerCoreServices logs preload errors without throwing", async () => {
  const container = new Container();
  const error = new Error("boom");
  const overrides = createBaseOverrides({
    allowedInviteService: {
      loadAll: async () => {
        throw error;
      }
    }
  });

  await registerCoreServices({ container, config: {}, services: overrides });

  assert.equal(overrides.logger.errorCalls.length, 1);
  assert.equal(overrides.logger.errorCalls[0][0], "invite_guard.allowlist_preload_failed");
  assert.match(overrides.logger.errorCalls[0][1].error, /boom/);
});
