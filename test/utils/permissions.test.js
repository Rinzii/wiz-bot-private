import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionsBitField } from "discord.js";
import {
  getDefaultPermBits,
  hasDefaultPerms,
  hasAppLevelPerms
} from "../../src/utils/permissions.js";
import { TOKENS } from "../../src/container.js";

test("getDefaultPermBits parses string and bigint inputs", () => {
  const flag = PermissionsBitField.Flags.ManageGuild;
  const commandA = { data: { default_member_permissions: String(flag) } };
  const commandB = { data: { default_member_permissions: BigInt(flag) } };

  const bitsA = getDefaultPermBits(commandA);
  const bitsB = getDefaultPermBits(commandB);

  assert.ok(bitsA instanceof PermissionsBitField);
  assert.ok(bitsB instanceof PermissionsBitField);
  assert.equal(bitsA.bitfield, BigInt(flag));
  assert.equal(bitsB.bitfield, BigInt(flag));
});

test("hasDefaultPerms uses member permission bitfield", () => {
  const flag = PermissionsBitField.Flags.KickMembers;
  const command = { data: { default_member_permissions: String(flag) } };
  const memberWithPerm = { permissions: new PermissionsBitField(flag) };
  const memberWithoutPerm = { permissions: new PermissionsBitField(0n) };

  assert.equal(hasDefaultPerms(memberWithPerm, command), true);
  assert.equal(hasDefaultPerms(memberWithoutPerm, command), false);
  assert.equal(hasDefaultPerms(memberWithoutPerm, { data: {} }), true);
});

test("hasAppLevelPerms enforces role and key requirements", async () => {
  const roleId = "role-1";
  const command = {
    meta: {
      requireRoles: [roleId],
      requireKeys: ["mod"]
    }
  };

  const memberRoles = new Map([[roleId, { id: roleId }]]);
  const interaction = {
    guildId: "guild-1",
    member: { roles: { cache: memberRoles } },
    client: {
      container: {
        get(token) {
          assert.equal(token, TOKENS.StaffRoleService);
          return {
            async getAllRoleIdsForKeys(guildId, keys) {
              assert.equal(guildId, "guild-1");
              assert.deepEqual(keys, ["mod"]);
              return [roleId, "other-role"];
            }
          };
        }
      }
    }
  };

  assert.equal(await hasAppLevelPerms(interaction, command), true);

  const interactionMissingRole = {
    ...interaction,
    member: { roles: { cache: new Map() } }
  };

  assert.equal(await hasAppLevelPerms(interactionMissingRole, command), false);

  const commandNoMeta = {};
  assert.equal(await hasAppLevelPerms(interaction, commandNoMeta), true);
});
