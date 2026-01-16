const assert = require("node:assert/strict");
const { test } = require("node:test");

const migrationUtils = require("../lib/migration-utils");

test("buildWsUrl adds /api and token", () => {
  const result = migrationUtils.buildWsUrl("https://example.local/z2m", "token-123");
  const parsed = new URL(result);
  assert.equal(parsed.protocol, "wss:");
  assert.equal(parsed.hostname, "example.local");
  assert.equal(parsed.pathname, "/z2m/api");
  assert.equal(parsed.searchParams.get("token"), "token-123");
});

test("buildHaWsUrl adds /api/websocket", () => {
  const result = migrationUtils.buildHaWsUrl("http://ha.local/base");
  const parsed = new URL(result);
  assert.equal(parsed.protocol, "ws:");
  assert.equal(parsed.pathname, "/base/api/websocket");
});

test("findCommonSuffix returns shared suffix", () => {
  assert.equal(migrationUtils.findCommonSuffix(["lamp_123", "sensor_123"]), "_123");
  assert.equal(migrationUtils.findCommonSuffix(["alpha", "betb"]), "");
  assert.equal(migrationUtils.findCommonSuffix([]), "");
});

test("matchDeviceByIeee matches identifiers case-insensitively", () => {
  const devices = [
    { id: "one", identifiers: [["zigbee2mqtt", "0x00124b0001abcd00"]] },
    { id: "two", identifiers: [["zigbee2mqtt", "0x0ABC"]]},
  ];
  assert.equal(migrationUtils.matchDeviceByIeee(devices, "0x00124B0001ABCD00").id, "one");
  assert.equal(migrationUtils.matchDeviceByIeee(devices, "0x0abc").id, "two");
  assert.equal(migrationUtils.matchDeviceByIeee(devices, "0xdeadbeef"), undefined);
});

test("isInterviewCompleteDevice handles deprecated and uppercase states", () => {
  const backend = { deviceStates: new Map() };
  const device = { friendly_name: "lamp", interview_state: "SUCCESSFUL" };
  assert.equal(migrationUtils.isInterviewCompleteDevice(device, backend), true);

  backend.deviceStates.set("lamp", { interview_status: "successful" });
  const devicePending = { friendly_name: "lamp", interview_completed: false };
  assert.equal(migrationUtils.isInterviewCompleteDevice(devicePending, backend), true);
});

test("isDeviceOnline respects availability and last_seen", () => {
  const backend = { availability: new Map(), deviceSeenAt: new Map() };
  const deviceOnline = { friendly_name: "sensor", availability: "online" };
  assert.equal(migrationUtils.isDeviceOnline(backend, deviceOnline), true);

  const oldStamp = new Date(Date.now() - migrationUtils.LAST_SEEN_ONLINE_MS - 1000).toISOString();
  const deviceOld = { friendly_name: "sensor", last_seen: oldStamp };
  assert.equal(migrationUtils.isDeviceOnline(backend, deviceOld), false);

  const freshStamp = new Date(Date.now() - 1000).toISOString();
  const deviceFresh = { friendly_name: "sensor", last_seen: freshStamp };
  assert.equal(migrationUtils.isDeviceOnline(backend, deviceFresh), true);
});

test("rewriteAutomationIds maps device and entity registry ids", () => {
  const deviceIdMap = new Map([["oldDevice", "newDevice"]]);
  const entityRegistryIdMap = new Map([["oldEntity", "newEntity"]]);
  const lookup = {
    registryIdSet: new Set(["oldEntity", "newEntity"]),
    deviceDomainMap: new Map(),
    snapshotDeviceIds: new Set(),
  };
  const input = {
    device_id: "oldDevice",
    entity_id: ["oldEntity", "keep"],
    nested: { device_id: "oldDevice" },
  };

  const result = migrationUtils.rewriteAutomationIds(input, deviceIdMap, entityRegistryIdMap, lookup);
  assert.equal(result.changed, true);
  assert.equal(result.value.device_id, "newDevice");
  assert.deepEqual(result.value.entity_id, ["newEntity", "keep"]);
});

test("rewriteAutomationIds resolves entity_id when device_id is mapped", () => {
  const deviceIdMap = new Map([["oldDevice", "newDevice"]]);
  const lookup = {
    registryIdSet: new Set(["newEntity"]),
    deviceDomainMap: new Map([["newDevice", new Map([["light", ["newEntity"]]])]]),
    snapshotDeviceIds: new Set(["newDevice"]),
  };
  const input = {
    device_id: "oldDevice",
    domain: "light",
    entity_id: "deadbeefdeadbeefdeadbeefdeadbeef",
  };

  const result = migrationUtils.rewriteAutomationIds(input, deviceIdMap, new Map(), lookup);
  assert.equal(result.changed, true);
  assert.equal(result.value.entity_id, "newEntity");
});
