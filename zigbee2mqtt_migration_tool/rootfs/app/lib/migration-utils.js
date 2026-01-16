const path = require("path");

const LAST_SEEN_ONLINE_MS = 10 * 60 * 1000;

const buildWsUrl = (url, token) => {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = path.posix.join(parsed.pathname || "/", "api");
  if (token) {
    parsed.searchParams.set("token", token);
  }
  return parsed.toString();
};

const buildHaWsUrl = (url) => {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = path.posix.join(parsed.pathname || "/", "api", "websocket");
  return parsed.toString();
};

const normalizeDeviceType = (device) => {
  if (!device || !device.type) {
    return "Unknown";
  }
  if (device.type === "Coordinator") {
    return "Coordinator";
  }
  if (device.type === "Router") {
    return "Router";
  }
  if (device.type === "EndDevice") {
    return "End device";
  }
  return device.type;
};

const normalizeInterviewState = (value) => (typeof value === "string" ? value.toLowerCase() : "");

const isInterviewCompleteDevice = (device, backend) => {
  if (!device || typeof device !== "object") {
    return false;
  }
  if (device.interview_completed === true) {
    return true;
  }
  if (normalizeInterviewState(device.interview_state) === "successful") {
    return true;
  }
  if (normalizeInterviewState(device.interview_status) === "successful") {
    return true;
  }
  if (!backend || !backend.deviceStates) {
    return false;
  }
  const name = device.friendly_name;
  if (!name) {
    return false;
  }
  const state = backend.deviceStates.get(name);
  if (!state || typeof state !== "object") {
    return false;
  }
  if (state.interview_completed === true) {
    return true;
  }
  if (normalizeInterviewState(state.interview_state) === "successful") {
    return true;
  }
  if (normalizeInterviewState(state.interview_status) === "successful") {
    return true;
  }
  return false;
};

const isDeviceOnline = (backend, device) => {
  if (device && typeof device.availability === "string") {
    return device.availability.toLowerCase() === "online";
  }
  if (device && device.availability && typeof device.availability === "object") {
    const state = device.availability.state;
    if (typeof state === "string") {
      return state.toLowerCase() === "online";
    }
  }
  const key = device && device.friendly_name ? device.friendly_name : null;
  if (!key) {
    return false;
  }
  const availability = backend.availability.get(key);
  if (typeof availability === "string") {
    return availability.toLowerCase() === "online";
  }
  if (availability && typeof availability === "object" && typeof availability.state === "string") {
    return availability.state.toLowerCase() === "online";
  }
  if (device && device.last_seen) {
    const seen = new Date(device.last_seen).getTime();
    if (!Number.isNaN(seen)) {
      return Date.now() - seen < LAST_SEEN_ONLINE_MS;
    }
  }
  if (backend.deviceSeenAt && key && backend.deviceSeenAt.has(key)) {
    const seen = backend.deviceSeenAt.get(key);
    if (typeof seen === "number") {
      return Date.now() - seen < LAST_SEEN_ONLINE_MS;
    }
  }
  if (typeof device.linkquality === "number" && device.linkquality > 0) {
    return true;
  }
  return false;
};

const findCommonSuffix = (values) => {
  if (!values || values.length === 0) {
    return "";
  }
  const reversed = values.map((value) => value.split("").reverse().join(""));
  let prefix = reversed[0];
  for (let i = 1; i < reversed.length; i += 1) {
    const current = reversed[i];
    let nextPrefix = "";
    const max = Math.min(prefix.length, current.length);
    for (let j = 0; j < max; j += 1) {
      if (prefix[j] !== current[j]) {
        break;
      }
      nextPrefix += prefix[j];
    }
    prefix = nextPrefix;
    if (!prefix) {
      break;
    }
  }
  return prefix.split("").reverse().join("");
};

const matchDeviceByIeee = (devices, ieee) => {
  const target = ieee.toLowerCase();
  return devices.find((device) => {
    if (!device || !Array.isArray(device.identifiers)) {
      return false;
    }
    return device.identifiers.some((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        return false;
      }
      const id = String(entry[1] || "").toLowerCase();
      return id === target || id.includes(target);
    });
  });
};

const rewriteAutomationIds = (value, deviceIdMap, entityRegistryIdMap, entityRegistryLookup) => {
  if (Array.isArray(value)) {
    let changed = false;
    let hits = 0;
    let deviceHits = 0;
    let entityHits = 0;
    const deviceIds = [];
    const entityIds = [];
    const next = value.map((item) => {
      const result = rewriteAutomationIds(item, deviceIdMap, entityRegistryIdMap, entityRegistryLookup);
      if (result.changed) {
        changed = true;
        hits += result.hits;
        deviceHits += result.deviceHits;
        entityHits += result.entityHits;
        deviceIds.push(...result.deviceIds);
        entityIds.push(...result.entityIds);
      }
      return result.value;
    });
    return { value: next, changed, hits, deviceHits, entityHits, deviceIds, entityIds };
  }
  if (!value || typeof value !== "object") {
    return { value, changed: false, hits: 0, deviceHits: 0, entityHits: 0, deviceIds: [], entityIds: [] };
  }
  let changed = false;
  let hits = 0;
  let deviceHits = 0;
  let entityHits = 0;
  const deviceIds = [];
  const entityIds = [];
  const next = {};
  const originalDeviceId = typeof value.device_id === "string" ? value.device_id : null;
  const mappedDeviceId =
    originalDeviceId && deviceIdMap && deviceIdMap.has(originalDeviceId)
      ? deviceIdMap.get(originalDeviceId)
      : originalDeviceId;
  const currentDeviceId = mappedDeviceId;
  const currentDomain = typeof value.domain === "string" ? value.domain : null;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "device_id" && typeof entry === "string" && deviceIdMap.has(entry)) {
      next[key] = deviceIdMap.get(entry);
      changed = true;
      hits += 1;
      deviceHits += 1;
      deviceIds.push(entry);
      continue;
    }
    if (key === "entity_id" && entityRegistryIdMap && entityRegistryIdMap.size > 0) {
      if (typeof entry === "string" && entityRegistryIdMap.has(entry)) {
        next[key] = entityRegistryIdMap.get(entry);
        changed = true;
        hits += 1;
        entityHits += 1;
        entityIds.push(entry);
        continue;
      }
      if (Array.isArray(entry)) {
        let updated = false;
        const mapped = entry.map((item) => {
          if (typeof item === "string" && entityRegistryIdMap.has(item)) {
            updated = true;
            hits += 1;
            entityHits += 1;
            entityIds.push(item);
            return entityRegistryIdMap.get(item);
          }
          return item;
        });
        if (updated) {
          next[key] = mapped;
          changed = true;
          continue;
        }
      }
    }
    if (
      key === "entity_id" &&
      typeof entry === "string" &&
      entityRegistryLookup &&
      currentDeviceId &&
      currentDomain
    ) {
      const looksLikeRegistryId = /^[a-f0-9]{32}$/i.test(entry);
      const knownIds = entityRegistryLookup.registryIdSet;
      if (
        looksLikeRegistryId &&
        !knownIds.has(entry) &&
        entityRegistryLookup.snapshotDeviceIds.has(currentDeviceId)
      ) {
        const domainMap = entityRegistryLookup.deviceDomainMap.get(currentDeviceId);
        const candidates = domainMap ? domainMap.get(currentDomain) : null;
        if (candidates && candidates.length === 1) {
          next[key] = candidates[0];
          changed = true;
          hits += 1;
          entityHits += 1;
          entityIds.push(entry);
          continue;
        }
      }
    }
    const result = rewriteAutomationIds(entry, deviceIdMap, entityRegistryIdMap, entityRegistryLookup);
    next[key] = result.value;
    if (result.changed) {
      changed = true;
      hits += result.hits;
      deviceHits += result.deviceHits;
      entityHits += result.entityHits;
      deviceIds.push(...result.deviceIds);
      entityIds.push(...result.entityIds);
    }
  }
  return { value: next, changed, hits, deviceHits, entityHits, deviceIds, entityIds };
};

module.exports = {
  LAST_SEEN_ONLINE_MS,
  buildWsUrl,
  buildHaWsUrl,
  normalizeDeviceType,
  isInterviewCompleteDevice,
  isDeviceOnline,
  findCommonSuffix,
  matchDeviceByIeee,
  rewriteAutomationIds,
};
