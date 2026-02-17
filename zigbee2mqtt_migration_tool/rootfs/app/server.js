const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const {
  buildWsUrl,
  buildHaWsUrl,
  findCommonSuffix,
  matchDeviceByIeee,
  normalizeDeviceType,
  isInterviewCompleteDevice,
  isDeviceOnline,
  rewriteAutomationIds,
} = require("./lib/migration-utils");

const OPTIONS_PATH = "/data/options.json";
const MAP_PATH = "/data/ieee-map.json";
const INSTALL_CODES_PATH = "/data/install-codes.json";
const HA_SNAPSHOT_PATH = "/data/ha-entity-map.json";
const COORDINATOR_MAP_PATH = "/data/coordinator-map.json";
const LISTEN_PORT = 8104;
const RECONNECT_DELAY_MS = 5000;
const MAX_ACTIVITY_ENTRIES = 250;
const ACTIVITY_TTL_MS = 3 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 15000;
const MIGRATION_TTL_MS = 60 * 60 * 1000;
const HA_REQUEST_TIMEOUT_MS = 8000;
const HA_RESTORE_RETRY_MS = 12000;
const HA_RESTORE_MAX_ATTEMPTS = 12;
const DEVICE_REFRESH_MS = 5 * 60 * 1000;

const readOptions = () => {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8"));
  } catch (error) {
    console.error("Failed to read options.json, using defaults.", error);
    return {};
  }
};

let options = {};
let optionsValidationErrors = [];

const normalizeOptionString = (value) => (typeof value === "string" ? value.trim() : "");

const validateOptions = (nextOptions) => {
  const errors = [];
  const serverOne = normalizeOptionString(nextOptions.server_one);
  const labelOne = normalizeOptionString(nextOptions.label_one);

  if (serverOne && !labelOne) {
    errors.push("label_one must be set when server_one is configured.");
  }
  return errors;
};

const loadOptions = () => {
  options = readOptions();
  optionsValidationErrors = validateOptions(options);
  for (const error of optionsValidationErrors) {
    console.error(`[CONFIG] ${error}`);
  }
  return options;
};

const buildBackends = () => {
  const candidates = [
    {
      id: "one",
      label: normalizeOptionString(options.label_one),
      url: normalizeOptionString(options.server_one),
      token: normalizeOptionString(options.auth_token_one),
    },
    {
      id: "two",
      label: normalizeOptionString(options.label_two),
      url: normalizeOptionString(options.server_two),
      token: normalizeOptionString(options.auth_token_two),
    },
    {
      id: "three",
      label: normalizeOptionString(options.label_three),
      url: normalizeOptionString(options.server_three),
      token: normalizeOptionString(options.auth_token_three),
    },
    {
      id: "four",
      label: normalizeOptionString(options.label_four),
      url: normalizeOptionString(options.server_four),
      token: normalizeOptionString(options.auth_token_four),
    },
  ];

  return candidates.filter((entry) => !!entry.url && !!entry.label);
};

let mappings = {};
let backends = [];
let deviceIndex = new Map();
const deviceNameToIeee = new Map();
let installCodes = {};
let haSnapshots = {};
let coordinatorSnapshots = {};
const recentActivity = [];
const pendingRemovals = new Map();
const pendingMigrations = new Map();
const pendingHaRestores = new Map();

const nowIso = () => new Date().toISOString();

const loadMappings = () => {
  try {
    const raw = fs.readFileSync(MAP_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.devices && typeof parsed.devices === "object") {
      mappings = parsed.devices;
      return;
    }
    if (parsed && typeof parsed === "object") {
      mappings = parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load IEEE mapping file", error);
    }
    mappings = {};
  }
};

const saveMappings = () => {
  const payload = {
    version: 1,
    updatedAt: nowIso(),
    devices: mappings,
  };
  try {
    fs.writeFileSync(MAP_PATH, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error("Failed to save IEEE mapping file", error);
  }
};

const loadInstallCodes = () => {
  try {
    const raw = fs.readFileSync(INSTALL_CODES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.codes && typeof parsed.codes === "object") {
      installCodes = parsed.codes;
      return;
    }
    if (parsed && typeof parsed === "object") {
      installCodes = parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load install codes file", error);
    }
    installCodes = {};
  }
};

const saveInstallCodes = () => {
  const payload = {
    version: 1,
    updatedAt: nowIso(),
    codes: installCodes,
  };
  try {
    fs.writeFileSync(INSTALL_CODES_PATH, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error("Failed to save install codes file", error);
  }
};

const loadHaSnapshots = () => {
  try {
    const raw = fs.readFileSync(HA_SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.devices && typeof parsed.devices === "object") {
      haSnapshots = parsed.devices;
      return;
    }
    if (parsed && typeof parsed === "object") {
      haSnapshots = parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load HA snapshot file", error);
    }
    haSnapshots = {};
  }
};

const saveHaSnapshots = () => {
  const payload = {
    version: 1,
    updatedAt: nowIso(),
    devices: haSnapshots,
  };
  try {
    fs.writeFileSync(HA_SNAPSHOT_PATH, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error("Failed to save HA snapshot file", error);
  }
};

const loadCoordinatorSnapshots = () => {
  try {
    const raw = fs.readFileSync(COORDINATOR_MAP_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.coordinators && typeof parsed.coordinators === "object") {
      coordinatorSnapshots = parsed.coordinators;
      return;
    }
    if (parsed && typeof parsed === "object") {
      coordinatorSnapshots = parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load coordinator snapshot file", error);
    }
    coordinatorSnapshots = {};
  }
};

const saveCoordinatorSnapshots = () => {
  const payload = {
    version: 1,
    updatedAt: nowIso(),
    coordinators: coordinatorSnapshots,
  };
  try {
    fs.writeFileSync(COORDINATOR_MAP_PATH, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error("Failed to save coordinator snapshot file", error);
  }
};

const isCoordinatorDevice = (backend, device) => {
  if (!device || typeof device !== "object") {
    return false;
  }
  if (device.type === "Coordinator") {
    return true;
  }
  if (device.friendly_name && device.friendly_name.toLowerCase() === "coordinator") {
    return true;
  }
  const ieee = device.ieee_address;
  const coordinatorIeee = backend?.bridgeInfo?.coordinator?.ieee_address;
  return !!ieee && !!coordinatorIeee && ieee === coordinatorIeee;
};

const buildCoordinatorIeeeSet = () => {
  const set = new Set();
  for (const backend of backends) {
    const ieee = backend?.bridgeInfo?.coordinator?.ieee_address;
    if (ieee) {
      set.add(ieee);
    }
  }
  return set;
};

const getHaConfig = () => {
  const url = options.homeassistant_url || "";
  const token = options.homeassistant_token || "";
  return { url: url.trim(), token: token.trim() };
};

const createHaClient = () => {
  const { url, token } = getHaConfig();
  if (!url || !token) {
    return Promise.reject(new Error("Home Assistant URL or token missing"));
  }
  const wsUrl = buildHaWsUrl(url);
  return new Promise((resolve, reject) => {
    let ready = false;
    let nextId = 1;
    const pending = new Map();
    const ws = new WebSocket(wsUrl);
    const request = (type, payload = {}) =>
      new Promise((resolveRequest, rejectRequest) => {
        if (!ready) {
          rejectRequest(new Error("Home Assistant WebSocket not ready"));
          return;
        }
        const id = nextId++;
        const body = { id, type, ...payload };
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`Home Assistant request timeout (${type})`));
        }, HA_REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
        ws.send(JSON.stringify(body));
      });

    const close = () => {
      ws.close();
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error("Home Assistant connection closed"));
      }
      pending.clear();
    };

    ws.on("message", (data) => {
      let message = null;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        console.error("[HA] Failed to parse WebSocket message", error);
        return;
      }
      if (message.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      }
      if (message.type === "auth_ok") {
        ready = true;
        resolve({ request, close });
        return;
      }
      if (message.type === "auth_invalid") {
        reject(new Error("Home Assistant auth failed"));
        close();
        return;
      }
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        clearTimeout(entry.timeout);
        pending.delete(message.id);
        if (message.success) {
          entry.resolve(message.result);
        } else {
          entry.reject(new Error(message.error?.message || "Home Assistant request failed"));
        }
      }
    });

    ws.on("error", (error) => {
      reject(error);
      close();
    });

    ws.on("close", () => {
      if (!ready) {
        reject(new Error("Home Assistant connection closed"));
      }
      close();
    });
  });
};

const withHaClient = async (callback) => {
  const client = await createHaClient();
  try {
    return await callback(client);
  } finally {
    client.close();
  }
};

const formatHaDevice = (device) => {
  if (!device) {
    return null;
  }
  return {
    id: device.id,
    name: device.name || device.name_by_user || "",
    identifiers: device.identifiers || [],
    connections: device.connections || [],
    manufacturer: device.manufacturer || "",
    model: device.model || "",
    sw_version: device.sw_version || "",
  };
};

const buildHaSnapshotWithClient = async (client, ieee) => {
  const [devices, entities] = await Promise.all([
    client.request("config/device_registry/list"),
    client.request("config/entity_registry/list"),
  ]);
  const device = matchDeviceByIeee(devices || [], ieee);
  if (!device) {
    return { device: null, entities: [], baseSuffix: "" };
  }
  const deviceEntities = (entities || []).filter((entry) => entry.device_id === device.id);
  const uniqueIds = deviceEntities.map((entry) => entry.unique_id).filter(Boolean);
  let baseSuffix = findCommonSuffix(uniqueIds);
  if (!baseSuffix.startsWith("_")) {
    baseSuffix = "";
  }
  const snapshotEntities = deviceEntities.map((entry) => ({
    entity_id: entry.entity_id,
    entity_registry_id: entry.id || "",
    unique_id: entry.unique_id,
    unique_id_base: baseSuffix ? entry.unique_id.slice(0, -baseSuffix.length) : entry.unique_id,
    original_name: entry.original_name || "",
    platform: entry.platform || "",
    domain: entry.entity_id.split(".")[0] || "",
  }));
  return {
    device: formatHaDevice(device),
    entities: snapshotEntities,
    baseSuffix,
  };
};

const buildHaSnapshot = async (ieee) => {
  return withHaClient((client) => buildHaSnapshotWithClient(client, ieee));
};

const saveHaSnapshotForIeee = async (ieee) => {
  const snapshot = await buildHaSnapshot(ieee);
  if (!snapshot.device) {
    throw new Error("Device not found in Home Assistant");
  }
  haSnapshots[ieee] = {
    updatedAt: nowIso(),
    ieee,
    ...snapshot,
  };
  saveHaSnapshots();
  return haSnapshots[ieee];
};

const buildHaDeviceInfoWithClient = async (client, ieee) => {
  const [devices, entities] = await Promise.all([
    client.request("config/device_registry/list"),
    client.request("config/entity_registry/list"),
  ]);
  const device = matchDeviceByIeee(devices || [], ieee);
  const currentDevice = formatHaDevice(device);
    const currentEntities = device
      ? (entities || [])
          .filter((entry) => entry.device_id === device.id)
          .map((entry) => ({
            entity_id: entry.entity_id,
            entity_registry_id: entry.id || "",
            unique_id: entry.unique_id,
            original_name: entry.original_name || "",
            platform: entry.platform || "",
          }))
      : [];

  const snapshot = haSnapshots[ieee] || null;
  const currentEntityById = new Map(currentEntities.map((entry) => [entry.entity_id, entry]));
  const currentEntityByBase = new Map();
  const currentSuffix = findCommonSuffix(currentEntities.map((entry) => entry.unique_id).filter(Boolean));
  const suffix = currentSuffix && currentSuffix.startsWith("_") ? currentSuffix : "";
  for (const entry of currentEntities) {
    const base = suffix ? entry.unique_id.slice(0, -suffix.length) : entry.unique_id;
    if (base) {
      currentEntityByBase.set(base, entry);
    }
  }

  const restorePlan = [];
  const usedRegistryIds = new Set();
  const matchedByIndex = new Map();
  if (snapshot && Array.isArray(snapshot.entities)) {
    snapshot.entities.forEach((saved, index) => {
      if (!saved || !saved.entity_id) {
        return;
      }
      const current = currentEntityById.get(saved.entity_id);
      if (!current) {
        return;
      }
      matchedByIndex.set(index, current);
      if (current.entity_registry_id) {
        usedRegistryIds.add(current.entity_registry_id);
      }
    });
    snapshot.entities.forEach((saved, index) => {
      const baseKey = saved.unique_id_base || saved.unique_id;
      const candidates = [
        saved.unique_id
          ? currentEntities.find((entry) => entry.unique_id === saved.unique_id)
          : null,
        baseKey ? currentEntityByBase.get(baseKey) : null,
        saved.original_name
          ? currentEntities.find((entry) => entry.original_name === saved.original_name)
          : null,
      ];
      let current = matchedByIndex.get(index) || null;
      if (!current) {
        current = candidates.find((entry) => entry && !usedRegistryIds.has(entry.entity_registry_id));
        if (current && current.entity_registry_id) {
          usedRegistryIds.add(current.entity_registry_id);
        }
      }
      const currentEntityId = current ? current.entity_id : null;
      const currentRegistryId = current ? current.entity_registry_id : null;
      let status = "missing";
      if (currentEntityId) {
        status = currentEntityId === saved.entity_id ? "ok" : "rename";
        if (currentEntityById.has(saved.entity_id) && saved.entity_id !== currentEntityId) {
          status = "conflict";
        }
        if (
          status === "ok" &&
          saved.entity_registry_id &&
          currentRegistryId &&
          saved.entity_registry_id !== currentRegistryId
        ) {
          status = "warn";
        }
      }
      restorePlan.push({
        desired_entity_id: saved.entity_id,
        current_entity_id: currentEntityId,
        desired_registry_id: saved.entity_registry_id || null,
        current_registry_id: currentRegistryId,
        unique_id: saved.unique_id,
        unique_id_base: saved.unique_id_base,
        status,
      });
    });
  }

  const deviceIdMap =
    snapshot && snapshot.device && currentDevice ? { from: snapshot.device.id, to: currentDevice.id } : null;

  return {
    snapshot,
    currentDevice,
    currentEntities,
    restorePlan,
    deviceIdMap,
  };
};

const buildHaDeviceInfo = async (ieee) => {
  return withHaClient((client) => buildHaDeviceInfoWithClient(client, ieee));
};

const restoreHaEntityIds = async (ieee) => {
  return withHaClient(async (client) => {
    const info = await buildHaDeviceInfoWithClient(client, ieee);
    const updates = [];
    for (const item of info.restorePlan || []) {
      if (item.status !== "rename") {
        continue;
      }
      updates.push({
        current: item.current_entity_id,
        desired: item.desired_entity_id,
      });
    }
    const results = [];
    for (const entry of updates) {
      const result = await client.request("config/entity_registry/update", {
        entity_id: entry.current,
        new_entity_id: entry.desired,
      });
      results.push({ current: entry.current, desired: entry.desired, result });
    }
    return { updates: results };
  });
};

const scheduleHaRestore = (ieee, reason) => {
  if (!ieee) {
    return;
  }
  const { url, token } = getHaConfig();
  if (!url || !token) {
    return;
  }
  const existing = pendingHaRestores.get(ieee);
  if (existing) {
    existing.attempts = 0;
    existing.nextAttemptAt = Date.now() + HA_RESTORE_RETRY_MS;
    existing.reason = reason || existing.reason;
    return;
  }
  pendingHaRestores.set(ieee, {
    ieee,
    attempts: 0,
    nextAttemptAt: Date.now() + HA_RESTORE_RETRY_MS,
    reason: reason || "rename",
  });
};

const processHaRestores = async () => {
  const now = Date.now();
  for (const [ieee, entry] of pendingHaRestores.entries()) {
    if (entry.nextAttemptAt > now) {
      continue;
    }
    entry.attempts += 1;
    entry.nextAttemptAt = now + HA_RESTORE_RETRY_MS;
    try {
      const result = await restoreHaEntityIds(ieee);
      const updates = result.updates || [];
      if (updates.length > 0) {
        pushActivity({
          time: nowIso(),
          type: "rename",
          message: `HA - Entity IDs restored for ${ieee} (${updates.length} updates)`,
        });
      }
      pendingHaRestores.delete(ieee);
    } catch (error) {
      if (entry.attempts >= HA_RESTORE_MAX_ATTEMPTS) {
        pendingHaRestores.delete(ieee);
        pushActivity({
          time: nowIso(),
          type: "log",
          message: `HA - Failed to restore entity IDs for ${ieee}: ${error.message}`,
        });
      }
    }
  }
};

const isUnknownHaCommand = (error) => {
  if (!error) {
    return false;
  }
  const message = String(error.message || error).toLowerCase();
  return message.includes("unknown command") || message.includes("unknown_command");
};

const haRestRequest = async (method, pathName, payload) => {
  const { url, token } = getHaConfig();
  if (!url || !token) {
    throw new Error("Home Assistant URL or token missing");
  }
  const target = new URL(pathName, url);
  const isHttps = target.protocol === "https:";
  const client = isHttps ? require("https") : require("http");
  const body = payload ? JSON.stringify(payload) : null;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  return new Promise((resolve, reject) => {
    const req = client.request(target, options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Home Assistant REST error ${res.statusCode}`));
          return;
        }
        if (!data) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
};

const fetchHaAutomations = async (client) => {
  const entities = await client.request("config/entity_registry/list");
  const automationEntities = (entities || []).filter(
    (entry) => entry && typeof entry.entity_id === "string" && entry.entity_id.startsWith("automation."),
  );
  if (automationEntities.length === 0) {
    return [];
  }
  const results = [];
  for (const entry of automationEntities) {
    const automationId = entry.unique_id || entry.entity_id;
    let config = null;
    try {
      const payload = await client.request("automation/config", { entity_id: entry.entity_id });
      config = payload?.config || null;
    } catch (error) {
      const message = String(error.message || "");
      if (!message.includes("Entity not found") && !message.includes("not found")) {
        throw error;
      }
    }
    if (!config && automationId) {
      try {
        config = await haRestRequest("GET", `/api/config/automation/config/${automationId}`);
      } catch (restError) {
        if (!String(restError.message || "").includes("404")) {
          throw restError;
        }
      }
    }
    if (!config) {
      continue;
    }
    results.push({
      id: automationId,
      config,
      alias: config.alias || entry.original_name || entry.entity_id,
      entity_id: entry.entity_id,
    });
  }
  return results;
};

const fetchHaDomainConfigs = async (client, domain, wsCommand, restPrefix) => {
  const entities = await client.request("config/entity_registry/list");
  const domainEntities = (entities || []).filter(
    (entry) => entry && typeof entry.entity_id === "string" && entry.entity_id.startsWith(`${domain}.`),
  );
  if (domainEntities.length === 0) {
    return [];
  }
  const results = [];
  for (const entry of domainEntities) {
    const entityId = entry.entity_id;
    const configId = entry.unique_id || entry.entity_id;
    let config = null;
    if (wsCommand) {
      try {
        const payload = await client.request(wsCommand, { entity_id: entityId });
        config = payload?.config || null;
      } catch (error) {
        if (!isUnknownHaCommand(error)) {
          const message = String(error.message || "");
          if (!message.includes("Entity not found") && !message.includes("not found")) {
            throw error;
          }
        }
      }
    }
    if (!config) {
      const restId = configId.includes(".") ? configId.split(".").slice(1).join(".") : configId;
      try {
        config = await haRestRequest("GET", `${restPrefix}/${encodeURIComponent(restId)}`);
      } catch (restError) {
        if (!String(restError.message || "").includes("404")) {
          throw restError;
        }
      }
    }
    if (!config) {
      continue;
    }
    results.push({
      id: configId,
      config,
      alias: config.alias || entry.original_name || entityId,
      entity_id: entityId,
    });
  }
  return results;
};

const fetchHaRewriteTargets = async (client) => {
  const [automationRaw, scriptsRaw, scenesRaw] = await Promise.all([
    fetchHaAutomations(client),
    fetchHaDomainConfigs(client, "script", "script/config", "/api/config/script/config"),
    fetchHaDomainConfigs(client, "scene", "scene/config", "/api/config/scene/config"),
  ]);
  const automations = automationRaw.map(normalizeAutomationEntry).filter(Boolean).map((entry) => ({
    ...entry,
    type: "automation",
  }));
  const scripts = scriptsRaw.map((entry) => ({ ...entry, type: "script" }));
  const scenes = scenesRaw.map((entry) => ({ ...entry, type: "scene" }));
  return {
    items: [...automations, ...scripts, ...scenes],
    counts: {
      automations: automations.length,
      scripts: scripts.length,
      scenes: scenes.length,
    },
  };
};

const normalizeAutomationEntry = (entry) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  if (entry.id && entry.config && typeof entry.config === "object") {
    return { id: entry.id, config: entry.config, alias: entry.config.alias || entry.config.id || "" };
  }
  if (entry.id && entry.trigger) {
    return { id: entry.id, config: entry, alias: entry.alias || entry.id || "" };
  }
  if (entry.alias && entry.trigger) {
    return { id: entry.id || entry.alias, config: entry, alias: entry.alias || entry.id || "" };
  }
  return null;
};

const applyHaConfigUpdate = async (type, id, value) => {
  if (!id) {
    return null;
  }
  const restId = id.includes(".") ? id.split(".").slice(1).join(".") : id;
  if (type === "script") {
    return haRestRequest("POST", `/api/config/script/config/${encodeURIComponent(restId)}`, value);
  }
  if (type === "scene") {
    return haRestRequest("POST", `/api/config/scene/config/${encodeURIComponent(restId)}`, value);
  }
  return haRestRequest("POST", `/api/config/automation/config/${id}`, value);
};

const buildDeviceIdMapWithClient = async (client) => {
  const devices = await client.request("config/device_registry/list");
  const map = new Map();
  const details = [];
  for (const [ieee, snapshot] of Object.entries(haSnapshots)) {
    if (!snapshot || !snapshot.device || !snapshot.device.id) {
      continue;
    }
    const current = matchDeviceByIeee(devices || [], ieee);
    if (!current || !current.id) {
      continue;
    }
    if (current.id === snapshot.device.id) {
      continue;
    }
    map.set(snapshot.device.id, current.id);
    details.push({
      ieee,
      from: snapshot.device.id,
      to: current.id,
      name: current.name || current.name_by_user || "",
    });
  }
  return { map, details };
};

const buildEntityRegistryIdMapWithClient = async (client, filterIeee = null) => {
  const [devices, entities] = await Promise.all([
    client.request("config/device_registry/list"),
    client.request("config/entity_registry/list"),
  ]);
  const map = new Map();
  const details = [];
  const registryIdSet = new Set();
  const deviceDomainMap = new Map();
  const snapshotDeviceIds = new Set();
  for (const entry of entities || []) {
    if (!entry || !entry.id || !entry.entity_id) {
      continue;
    }
    registryIdSet.add(entry.id);
    const domain = entry.entity_id.split(".")[0];
    if (!entry.device_id || !domain) {
      continue;
    }
    if (!deviceDomainMap.has(entry.device_id)) {
      deviceDomainMap.set(entry.device_id, new Map());
    }
    const domainMap = deviceDomainMap.get(entry.device_id);
    if (!domainMap.has(domain)) {
      domainMap.set(domain, []);
    }
    domainMap.get(domain).push(entry.id);
  }
  for (const [ieee, snapshot] of Object.entries(haSnapshots)) {
    if (filterIeee && ieee !== filterIeee) {
      continue;
    }
    if (!snapshot || !snapshot.device || !snapshot.device.id || !snapshot.entities) {
      continue;
    }
    const currentDevice = matchDeviceByIeee(devices || [], ieee);
    if (!currentDevice || !currentDevice.id) {
      continue;
    }
    snapshotDeviceIds.add(currentDevice.id);
    const currentEntities = (entities || [])
      .filter((entry) => entry.device_id === currentDevice.id)
      .map((entry) => ({
        entity_id: entry.entity_id,
        entity_registry_id: entry.id || "",
        unique_id: entry.unique_id,
        original_name: entry.original_name || "",
      }));
    const currentSuffix = findCommonSuffix(currentEntities.map((entry) => entry.unique_id).filter(Boolean));
    const suffix = currentSuffix && currentSuffix.startsWith("_") ? currentSuffix : "";
    const currentByBase = new Map();
    for (const entry of currentEntities) {
      const base = suffix ? entry.unique_id.slice(0, -suffix.length) : entry.unique_id;
      if (base) {
        currentByBase.set(base, entry);
      }
    }
    for (const saved of snapshot.entities) {
      if (!saved.entity_registry_id) {
        continue;
      }
      const baseKey = saved.unique_id_base || saved.unique_id;
      const current =
        (baseKey && currentByBase.get(baseKey)) ||
        currentEntities.find((entry) => entry.unique_id === saved.unique_id) ||
        currentEntities.find((entry) => entry.original_name === saved.original_name) ||
        null;
      if (!current || !current.entity_registry_id) {
        continue;
      }
      if (current.entity_registry_id === saved.entity_registry_id) {
        continue;
      }
      map.set(saved.entity_registry_id, current.entity_registry_id);
      details.push({
        ieee,
        from: saved.entity_registry_id,
        to: current.entity_registry_id,
      });
    }
  }
  return { map, details, registryIdSet, deviceDomainMap, snapshotDeviceIds };
};

const buildDeviceIdMap = async () => {
  return withHaClient((client) => buildDeviceIdMapWithClient(client));
};

const previewAutomationRewrite = async () => {
  return withHaClient(async (client) => {
    const { items, counts } = await fetchHaRewriteTargets(client);
    const { map, details } = await buildDeviceIdMapWithClient(client);
    const entityInfo = await buildEntityRegistryIdMapWithClient(client);
    const { map: entityMap, details: entityDetails } = entityInfo;
    const deviceIdToIeee = new Map(details.map((entry) => [entry.from, entry.ieee]));
    const entityIdToIeee = new Map(entityDetails.map((entry) => [entry.from, entry.ieee]));
    let affectedAutomations = 0;
    let replacementHits = 0;
    let deviceHits = 0;
    let entityHits = 0;
    const affected = [];
    for (const entry of items) {
      const result = rewriteAutomationIds(entry.config, map, entityMap, entityInfo);
      if (result.changed) {
        affectedAutomations += 1;
        replacementHits += result.hits;
        deviceHits += result.deviceHits;
        entityHits += result.entityHits;
        const ieees = new Set();
        result.deviceIds.forEach((id) => {
          const ieee = deviceIdToIeee.get(id);
          if (ieee) {
            ieees.add(ieee);
          }
        });
        result.entityIds.forEach((id) => {
          const ieee = entityIdToIeee.get(id);
          if (ieee) {
            ieees.add(ieee);
          }
        });
        affected.push({
          id: entry.id || "",
          alias: entry.alias || "",
          hits: result.hits,
          deviceHits: result.deviceHits,
          entityHits: result.entityHits,
          type: entry.type || "automation",
          ieees: [...ieees],
        });
      }
    }
    const mapSummary = details
      .map((entry) => `${entry.ieee}:${entry.from}->${entry.to}`)
      .join(", ");
    console.log(
      `[HA] automation preview: automations=${counts.automations} scripts=${counts.scripts} scenes=${counts.scenes} affected=${affectedAutomations} hits=${replacementHits} deviceHits=${deviceHits} entityHits=${entityHits} deviceMap=[${mapSummary}] entityMapCount=${entityDetails.length}`,
    );
    if (affected.length > 0) {
      const list = affected
        .map((entry) => `${entry.alias || entry.id || "automation"} (${entry.id}) hits=${entry.hits}`)
        .join("; ");
      console.log(`[HA] affected automations: ${list}`);
    }
    return {
      automations: counts.automations,
      scripts: counts.scripts,
      scenes: counts.scenes,
      affectedAutomations,
      replacementHits,
      deviceHits,
      entityHits,
      deviceIdMap: details,
      entityIdMap: entityDetails,
      affected,
    };
  });
};

const applyAutomationRewrite = async () => {
  return withHaClient(async (client) => {
    const { items } = await fetchHaRewriteTargets(client);
    const { map, details } = await buildDeviceIdMapWithClient(client);
    const entityInfo = await buildEntityRegistryIdMapWithClient(client);
    const { map: entityMap } = entityInfo;
    let updated = 0;
    let replacementHits = 0;
    for (const entry of items) {
      const result = rewriteAutomationIds(entry.config, map, entityMap, entityInfo);
      if (!result.changed) {
        continue;
      }
      if (!entry.id) {
        continue;
      }
      await applyHaConfigUpdate(entry.type, entry.id, result.value);
      updated += 1;
      replacementHits += result.hits;
    }
    return {
      updated,
      replacementHits,
      deviceIdMap: details,
    };
  });
};

const applyAutomationRewriteForDevice = async (ieee) => {
  return withHaClient(async (client) => {
    const { items } = await fetchHaRewriteTargets(client);
    const deviceMap = await buildDeviceIdMapWithClient(client);
    const entityInfo = await buildEntityRegistryIdMapWithClient(client, ieee);
    const deviceMapEntries = deviceMap.details.filter((entry) => entry.ieee === ieee);
    const deviceIdMap = new Map(deviceMapEntries.map((entry) => [entry.from, entry.to]));
    const entityIdMap = entityInfo.map;
    const entityInfoScoped = {
      ...entityInfo,
      snapshotDeviceIds: new Set(entityInfo.snapshotDeviceIds),
    };
    let updated = 0;
    let replacementHits = 0;
    for (const entry of items) {
      const result = rewriteAutomationIds(entry.config, deviceIdMap, entityIdMap, entityInfoScoped);
      if (!result.changed) {
        continue;
      }
      if (!entry.id) {
        continue;
      }
      await applyHaConfigUpdate(entry.type, entry.id, result.value);
      updated += 1;
      replacementHits += result.hits;
    }
    return {
      updated,
      replacementHits,
      deviceIdMap: deviceMapEntries,
      entityIdMap: entityInfo.details,
    };
  });
};

const previewAutomationRewriteForDevice = async (ieee) => {
  return withHaClient(async (client) => {
    const { items, counts } = await fetchHaRewriteTargets(client);
    const deviceMap = await buildDeviceIdMapWithClient(client);
    const entityInfo = await buildEntityRegistryIdMapWithClient(client, ieee);
    const deviceMapEntries = deviceMap.details.filter((entry) => entry.ieee === ieee);
    const deviceIdMap = new Map(deviceMapEntries.map((entry) => [entry.from, entry.to]));
    const entityIdMap = entityInfo.map;
    const entityInfoScoped = {
      ...entityInfo,
      snapshotDeviceIds: new Set(entityInfo.snapshotDeviceIds),
    };
    let affectedAutomations = 0;
    let replacementHits = 0;
    let deviceHits = 0;
    let entityHits = 0;
    const affected = [];
    for (const entry of items) {
      const result = rewriteAutomationIds(entry.config, deviceIdMap, entityIdMap, entityInfoScoped);
      if (result.changed) {
        affectedAutomations += 1;
        replacementHits += result.hits;
        deviceHits += result.deviceHits;
        entityHits += result.entityHits;
        affected.push({
          id: entry.id || "",
          alias: entry.alias || "",
          hits: result.hits,
          type: entry.type || "automation",
        });
      }
    }
    return {
      automations: counts.automations,
      scripts: counts.scripts,
      scenes: counts.scenes,
      affectedAutomations,
      replacementHits,
      deviceHits,
      entityHits,
      deviceIdMap: deviceMapEntries,
      entityIdMap: entityInfo.details,
      affected,
    };
  });
};

const rebuildDeviceIndex = () => {
  const nextIndex = new Map();
  let mappingsChanged = false;
  deviceNameToIeee.clear();

  for (const backend of backends) {
    if (!backend.devicesRaw) {
      continue;
    }

    for (const device of backend.devicesRaw) {
      if (!device || !device.ieee_address) {
        continue;
      }
      if (isCoordinatorDevice(backend, device)) {
        continue;
      }
      const ieee = device.ieee_address;
      let entry = nextIndex.get(ieee);
      if (!entry) {
        entry = {
          ieee,
          instances: [],
          namesByBackend: {},
          model: device.definition?.model || device.model_id || "",
          vendor: device.definition?.vendor || "",
          modelId: device.model_id || "",
          supported: device.supported === true,
          type: normalizeDeviceType(device),
          online: false,
          interviewCompleted: device.interview_completed !== false,
          linkquality: typeof device.linkquality === "number" ? device.linkquality : null,
          lastSeen: device.last_seen || null,
        };
        nextIndex.set(ieee, entry);
      }
      entry.instances.push(backend.label);
      entry.namesByBackend[backend.id] = device.friendly_name;
      deviceNameToIeee.set(`${backend.id}:${device.friendly_name}`, ieee);
      entry.model = entry.model || device.definition?.model || device.model_id || "";
      entry.vendor = entry.vendor || device.definition?.vendor || "";
      entry.modelId = entry.modelId || device.model_id || "";
      entry.supported = entry.supported || device.supported === true;
      entry.type = entry.type !== "Unknown" ? entry.type : normalizeDeviceType(device);
      entry.online = entry.online || isDeviceOnline(backend, device);
      entry.interviewCompleted = entry.interviewCompleted && device.interview_completed !== false;
      if (typeof device.linkquality === "number") {
        entry.linkquality = device.linkquality;
      } else if (backend.deviceStates && backend.deviceStates.has(device.friendly_name)) {
        const state = backend.deviceStates.get(device.friendly_name);
        if (state && typeof state.linkquality === "number") {
          entry.linkquality = state.linkquality;
        }
      }
      if (device.last_seen) {
        entry.lastSeen = device.last_seen;
      } else if (backend.deviceStates && backend.deviceStates.has(device.friendly_name)) {
        const state = backend.deviceStates.get(device.friendly_name);
        if (state && state.last_seen) {
          entry.lastSeen = state.last_seen;
        }
      }

      let mapping = mappings[ieee];
      if (!mapping) {
        mapping = {
          name: device.friendly_name,
          updatedAt: nowIso(),
        };
        mappings[ieee] = mapping;
        mappingsChanged = true;
      }
      const nextModel = device.definition?.model || device.model_id || "";
      const nextVendor = device.definition?.vendor || "";
      const nextModelId = device.model_id || "";
      const nextSupported = device.supported === true;
      let metaChanged = false;
      if (nextModel && mapping.model !== nextModel) {
        mapping.model = nextModel;
        metaChanged = true;
      }
      if (nextVendor && mapping.vendor !== nextVendor) {
        mapping.vendor = nextVendor;
        metaChanged = true;
      }
      if (nextModelId && mapping.modelId !== nextModelId) {
        mapping.modelId = nextModelId;
        metaChanged = true;
      }
      if (nextSupported && mapping.supported !== true) {
        mapping.supported = true;
        metaChanged = true;
      }
      if (metaChanged) {
        mapping.updatedAt = nowIso();
        mappingsChanged = true;
      }
    }
  }

  deviceIndex = nextIndex;
  if (mappingsChanged) {
    saveMappings();
  }
  resolveRemovals();
  updateMigrations();
};

const resolveRemovals = () => {
  for (const [ieee, pending] of pendingRemovals.entries()) {
    if (!deviceIndex.has(ieee)) {
      pending.resolve({ status: "removed" });
      pendingRemovals.delete(ieee);
    }
  }
};

const firstKnownName = (entry) => {
  const backendIds = Object.keys(entry.namesByBackend || {});
  if (backendIds.length === 0) {
    return "";
  }
  return entry.namesByBackend[backendIds[0]];
};

const summarizeOverview = () => {
  const overview = {
    devices: 0,
    online: 0,
    router: 0,
    endDevice: 0,
    lowLqi: 0,
  };

  for (const entry of deviceIndex.values()) {
    overview.devices += 1;
    if (entry.online) {
      overview.online += 1;
    }
    if (entry.type === "Router") {
      overview.router += 1;
    }
    if (entry.type === "End device") {
      overview.endDevice += 1;
    }
    if (typeof entry.linkquality === "number" && entry.linkquality < 50) {
      overview.lowLqi += 1;
    }
  }

  return overview;
};

const buildPairingStatus = () => {
  const active = [];
  for (const backend of backends) {
    if (backend.bridgeInfo && backend.bridgeInfo.permit_join) {
      let remaining = null;
      if (backend.permitJoinEndsAt) {
        const seconds = Math.max(0, Math.ceil((backend.permitJoinEndsAt - Date.now()) / 1000));
        remaining = seconds;
      }
      active.push({ id: backend.id, label: backend.label, remaining });
    }
  }
  return active;
};

const getActivePairingBackend = () => {
  const active = backends.filter((backend) => backend.bridgeInfo && backend.bridgeInfo.permit_join);
  if (active.length === 1) {
    return active[0];
  }
  return null;
};

const getCoordinatorRevision = (meta) => {
  if (!meta || typeof meta !== "object") {
    return "";
  }
  return meta.revision || meta.Revision || meta.firmware || "";
};

const buildCoordinatorList = () => {
  const coordinators = [];
  for (const backend of backends) {
    const info = backend.bridgeInfo;
    const coordinator = info && info.coordinator ? info.coordinator : null;
    if (!coordinator) {
      continue;
    }
    const revision = getCoordinatorRevision(coordinator.meta || {});
    const snapshot = coordinatorSnapshots[backend.id] || null;
    const current = {
      type: coordinator.type || "",
      ieee: coordinator.ieee_address || "",
      revision: revision || "",
      serialPort: info?.config?.serial?.port || "",
      adapter: info?.config?.serial?.adapter || "",
    };
    const changed =
      !!snapshot &&
      (snapshot.ieee !== current.ieee ||
        snapshot.type !== current.type ||
        snapshot.serialPort !== current.serialPort ||
        snapshot.adapter !== current.adapter ||
        snapshot.revision !== current.revision);
    coordinators.push({
      id: backend.id,
      label: backend.label,
      type: current.type,
      ieee: current.ieee,
      revision: current.revision,
      serialPort: current.serialPort,
      adapter: current.adapter,
      saved: snapshot,
      changed,
    });
  }
  return coordinators;
};

const describeMigration = (migration) => {
  if (!migration) {
    return null;
  }
  const pairingHint = "Enable device pairing now";
  if (!migration.leftOld) {
    return "Removing from source";
  }
  if (migration.configuring && !migration.configured) {
    return "Configuring on target";
  }
  if (migration.configured && !migration.renameSent) {
    return "Configuration complete";
  }
  if (migration.renameSent && !migration.blocklistRemoved && migration.force) {
    return "Finishing migration";
  }
  return `Migrating · ${pairingHint}`;
};

const buildDeviceList = () => {
  const combined = [];
  const seen = new Set();
  const coordinatorIeees = buildCoordinatorIeeeSet();

  for (const ieee of Object.keys(mappings)) {
    seen.add(ieee);
  }
  for (const ieee of deviceIndex.keys()) {
    seen.add(ieee);
  }

  for (const ieee of seen) {
    if (coordinatorIeees.has(ieee)) {
      continue;
    }
    const mapping = mappings[ieee] || { name: "" };
    const entry = deviceIndex.get(ieee);
    const migration = pendingMigrations.get(ieee);
    const mappingName = mapping.name ? mapping.name.trim() : "";
    const currentName = entry ? firstKnownName(entry) : "";
    const nameMismatch =
      !!entry &&
      !!mappingName &&
      Object.values(entry.namesByBackend || {}).some((name) => name && name !== mappingName);
    const fallback = entry || {
      instances: [],
      model: mapping.model || "",
      vendor: mapping.vendor || "",
      modelId: mapping.modelId || "",
      supported: mapping.supported === true,
      type: "Unknown",
      online: false,
      interviewCompleted: false,
      linkquality: null,
      lastSeen: null,
    };
    combined.push({
      ieee,
      mappedName: mappingName,
      currentName,
      nameMismatch,
      instances: fallback.instances,
      model: fallback.model || mapping.model || "",
      vendor: fallback.vendor || mapping.vendor || "",
      modelId: fallback.modelId || mapping.modelId || "",
      supported: fallback.supported || mapping.supported === true,
      type: fallback.type,
      online: fallback.online,
      interviewCompleted: fallback.interviewCompleted,
      linkquality: fallback.linkquality,
      lastSeen: fallback.lastSeen,
      installCode: installCodes[ieee] || "",
      migrationStatus: migration ? describeMigration(migration) : null,
      migrationTarget: migration ? migration.targetBackendId : null,
    });
  }

  combined.sort((a, b) => (a.mappedName || a.ieee).localeCompare(b.mappedName || b.ieee));
  return combined;
};

const pruneActivity = () => {
  const cutoff = Date.now() - ACTIVITY_TTL_MS;
  while (recentActivity.length > 0) {
    const last = recentActivity[recentActivity.length - 1];
    if (new Date(last.time).getTime() < cutoff) {
      recentActivity.pop();
    } else {
      break;
    }
  }
};

const pushActivity = (entry) => {
  recentActivity.unshift(entry);
  if (recentActivity.length > MAX_ACTIVITY_ENTRIES) {
    recentActivity.pop();
  }
  pruneActivity();
};

const formatChangeMessage = (backend, name, changes) => {
  if (!changes || changes.length === 0) {
    return null;
  }
  const detail = changes.join(", ");
  return `${backend.label} - ${name} -- ${detail}`;
};

const buildDiff = (prev, next) => {
  if (!prev || typeof prev !== "object" || !next || typeof next !== "object") {
    return [];
  }
  const changes = [];
  const keys = Object.keys(next);
  for (const key of keys) {
    if (key === "last_seen") {
      continue;
    }
    const nextValue = next[key];
    const prevValue = prev[key];
    const nextType = typeof nextValue;
    if (!["string", "number", "boolean"].includes(nextType)) {
      continue;
    }
    if (prevValue === nextValue) {
      continue;
    }
    const prevText = typeof prevValue === "undefined" ? "-" : String(prevValue);
    changes.push(`${key}: ${prevText} -> ${String(nextValue)}`);
  }
  return changes;
};

const formatLogValue = (value) => {
  if (value === null || typeof value === "undefined") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return "[object]";
  }
};

const formatLogContext = (context = {}) => {
  return Object.entries(context)
    .filter(([, value]) => value !== null && typeof value !== "undefined" && value !== "")
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
};

const logUiAction = (action, context = {}) => {
  const details = formatLogContext(context);
  const line = details ? `[UI ACTION] ${action} ${details}` : `[UI ACTION] ${action}`;
  console.log(line);
  pushActivity({
    time: nowIso(),
    type: "log",
    message: details ? `UI click: ${action} (${details})` : `UI click: ${action}`,
  });
};

const logZ2mTx = (backend, topic, context = {}) => {
  const details = formatLogContext({
    backend: backend?.label || backend?.id || "unknown",
    topic,
    ...context,
  });
  console.log(`[Z2M TX] ${details}`);
};

const sendRename = (backend, fromName, toName, source = "unknown") => {
  logZ2mTx(backend, "bridge/request/device/rename", {
    source,
    from: fromName,
    to: toName,
    homeassistant_rename: false,
  });
  backend.send({
    topic: "bridge/request/device/rename",
    payload: {
      from: fromName,
      to: toName,
      homeassistant_rename: false,
    },
  });
};

const sendRemove = (backend, ieee, force, source = "unknown") => {
  logZ2mTx(backend, "bridge/request/device/remove", {
    source,
    id: ieee,
    force: !!force,
  });
  backend.send({
    topic: "bridge/request/device/remove",
    payload: {
      id: ieee,
      force: !!force,
    },
  });
};

const getBlocklist = (backend) => {
  const list = backend && backend.bridgeInfo && backend.bridgeInfo.config && backend.bridgeInfo.config.blocklist;
  return Array.isArray(list) ? list : [];
};

const sendBlocklistAdd = (backend, ieee, source = "unknown") => {
  const current = getBlocklist(backend);
  const next = current.includes(ieee) ? current : [...current, ieee];
  logZ2mTx(backend, "bridge/request/options", {
    source,
    action: "blocklist_add",
    id: ieee,
    blocklist_size: next.length,
  });
  backend.send({
    topic: "bridge/request/options",
    payload: {
      options: {
        blocklist: next,
      },
    },
  });
};

const sendBlocklistRemove = (backend, ieee, source = "unknown") => {
  const current = getBlocklist(backend);
  const next = current.filter((item) => item !== ieee);
  logZ2mTx(backend, "bridge/request/options", {
    source,
    action: "blocklist_remove",
    id: ieee,
    blocklist_size: next.length,
  });
  backend.send({
    topic: "bridge/request/options",
    payload: {
      options: {
        blocklist: next,
      },
    },
  });
};

const sendInstallCodeAdd = (backend, ieee, code, source = "unknown") => {
  logZ2mTx(backend, "bridge/request/install_code/add", {
    source,
    label: ieee,
    code_len: typeof code === "string" ? code.length : 0,
  });
  backend.send({
    topic: "bridge/request/install_code/add",
    payload: {
      value: code,
      label: ieee,
    },
  });
};

const sendPermitJoin = (backend, time, source = "unknown") => {
  logZ2mTx(backend, "bridge/request/permit_join", {
    source,
    time,
  });
  backend.send({
    topic: "bridge/request/permit_join",
    payload: {
      time,
    },
  });
};

const updateMigrations = () => {
  const now = Date.now();
  for (const [ieee, migration] of pendingMigrations.entries()) {
    if (now - migration.startedAt > MIGRATION_TTL_MS) {
      pendingMigrations.delete(ieee);
      pushActivity({
        time: nowIso(),
        type: "migration",
        message: `Migration timed out for ${ieee}`,
      });
      continue;
    }

    const sourceBackends = migration.sourceBackendIds
      .map((id) => backends.find((backend) => backend.id === id))
      .filter(Boolean);
    const inSource = sourceBackends.some(
      (backend) => backend.devicesByIeee && backend.devicesByIeee.has(ieee),
    );
    if (!migration.leftOld && !inSource) {
      migration.leftOld = true;
      pushActivity({
        time: nowIso(),
        type: "migration",
        message: `Device ${ieee} left ${migration.sourceLabels.join(", ")}`,
      });
    }

    if (!migration.targetBackendId) {
      const target = backends.find(
        (backend) =>
          !migration.sourceBackendIds.includes(backend.id) &&
          backend.devicesByIeee &&
          backend.devicesByIeee.has(ieee),
      );
      if (target) {
        migration.targetBackendId = target.id;
        pushActivity({
          time: nowIso(),
          type: "migration",
          message: `Device ${ieee} joined ${target.label}`,
        });
      }
    }

    if (migration.targetBackendId) {
      const target = backends.find((backend) => backend.id === migration.targetBackendId);
      const device = target && target.devicesByIeee ? target.devicesByIeee.get(ieee) : null;
      const interviewComplete = target && device ? isInterviewCompleteDevice(device, target) : false;
      if (!migration.configuring && !interviewComplete) {
        migration.configuring = true;
        pushActivity({
          time: nowIso(),
          type: "migration",
          message: `Device ${ieee} is configuring on ${target.label}`,
        });
      }
      if (!migration.configured && interviewComplete) {
        migration.configured = true;
        pushActivity({
          time: nowIso(),
          type: "migration",
          message: `Device ${ieee} configuration finished on ${target.label}`,
        });
      }

      if (migration.configured && !migration.renameSent && target && device) {
        const mapping = mappings[ieee];
        const desired = mapping && mapping.name ? mapping.name.trim() : "";
        const current = device.friendly_name;
        if (desired && current && desired !== current) {
          sendRename(target, current, desired, "auto_migration_rename");
          pushActivity({
            time: nowIso(),
            type: "rename",
            message: `${target.label} - Rename command sent: ${current} -> ${desired}`,
          });
          scheduleHaRestore(ieee, "auto-rename");
        }
        migration.renameSent = true;
      }

      if (migration.force && migration.configured && !migration.blocklistRemoved) {
        for (const backend of sourceBackends) {
          sendBlocklistRemove(backend, ieee, "auto_force_cleanup");
          pushActivity({
            time: nowIso(),
            type: "migration",
            message: `${backend.label} - Blocklist remove command sent for ${ieee}`,
          });
        }
        migration.blocklistRemoved = true;
      }

      if (migration.configured && (!migration.force || migration.blocklistRemoved)) {
        pendingMigrations.delete(ieee);
      }
    }
  }
};

class Backend {
  constructor(config) {
    this.id = config.id;
    this.label = config.label;
    this.url = config.url;
    this.token = config.token;
    this.connected = false;
    this.ws = null;
    this.devicesRaw = null;
    this.availability = new Map();
    this.bridgeInfo = null;
    this.permitJoinEndsAt = null;
    this.deviceStates = new Map();
    this.deviceSeenAt = new Map();
    this.devicesByIeee = new Map();
  }

  connect() {
    const wsUrl = buildWsUrl(this.url, this.token);
    console.log(`[${this.label}] Connecting to ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      this.connected = true;
      console.log(`[${this.label}] Connected`);
      this.requestDevices();
    });

    this.ws.on("message", (data) => {
      this.onMessage(data.toString());
    });

    this.ws.on("close", () => {
      this.connected = false;
      console.warn(`[${this.label}] Disconnected, retrying in ${RECONNECT_DELAY_MS}ms`);
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on("error", (error) => {
      console.error(`[${this.label}] WebSocket error`, error.message || error);
    });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn(`[${this.label}] Backend not connected, dropping message ${message.topic}`);
    }
  }

  requestDevices() {
    this.send({
      topic: "bridge/request/devices",
      payload: {},
    });
  }

  onMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error(`[${this.label}] Invalid JSON from backend`, error);
      return;
    }

    if (!data || !data.topic) {
      return;
    }

    if (typeof data.topic === "string" && data.topic.endsWith("/availability")) {
      const base = data.topic.split("/availability")[0];
      this.availability.set(base, data.payload);
      const ieee = deviceNameToIeee.get(`${this.id}:${base}`);
      if (ieee && deviceIndex.has(ieee)) {
        const entry = deviceIndex.get(ieee);
        const availability = data.payload;
        let online = entry.online;
        if (typeof availability === "string") {
          online = availability.toLowerCase() === "online";
        } else if (availability && typeof availability.state === "string") {
          online = availability.state.toLowerCase() === "online";
        }
        entry.online = online;
      }
      return;
    }

    if (data.topic.startsWith("bridge/")) {
      switch (data.topic) {
        case "bridge/devices":
        case "bridge/response/devices":
          this.devicesRaw = Array.isArray(data.payload) ? data.payload : [];
          console.log(`[${this.label}] bridge/devices ${this.devicesRaw.length}`);
          this.devicesByIeee = new Map();
          for (const device of this.devicesRaw) {
            if (device && device.ieee_address) {
              this.devicesByIeee.set(device.ieee_address, device);
            }
          }
          rebuildDeviceIndex();
          return;
        case "bridge/info":
          this.bridgeInfo = data.payload || null;
          if (this.bridgeInfo && typeof this.bridgeInfo.permit_join_end === "number") {
            this.permitJoinEndsAt = this.bridgeInfo.permit_join_end;
          } else if (this.bridgeInfo && typeof this.bridgeInfo.permit_join_timeout === "number") {
            this.permitJoinEndsAt = Date.now() + this.bridgeInfo.permit_join_timeout * 1000;
          } else if (this.bridgeInfo && this.bridgeInfo.permit_join === false) {
            this.permitJoinEndsAt = null;
          }
          return;
        case "bridge/logging":
          if (data.payload && typeof data.payload.message === "string") {
            const message = data.payload.message;
            if (/MQTT publish:/i.test(message)) {
              return;
            }
            const joined = /(joined|interviewing|interview completed)/i.test(message);
            const left = /(left|leave|removed|deleted)/i.test(message);
            if (joined || left) {
              pushActivity({
                time: nowIso(),
                type: joined ? "join" : "leave",
                message: `${this.label} - ${message}`,
              });
            }
          }
          return;
        case "bridge/response/device/remove":
          return;
        case "bridge/response/device/rename":
          return;
        case "bridge/response/permit_join":
          if (data.payload && data.payload.status === "ok") {
            const time =
              typeof data.payload.time === "number"
                ? data.payload.time
                : typeof data.payload.data?.time === "number"
                  ? data.payload.data.time
                  : null;
            if (typeof time === "number" && time > 0) {
              this.permitJoinEndsAt = Date.now() + time * 1000;
            } else {
              this.permitJoinEndsAt = null;
            }
          }
          return;
        default:
          return;
      }
    }

    const topicParts = data.topic.split("/");
    const name = topicParts[0];
    const payload = data.payload;
    if (name && payload && typeof payload === "object" && !Array.isArray(payload)) {
      const previous = this.deviceStates.get(name);
      const changes = buildDiff(previous, payload);
      if (changes.length > 0) {
        const message = formatChangeMessage(this, name, changes);
        if (message) {
          pushActivity({
            time: nowIso(),
            type: "change",
            message,
          });
        }
      }
      this.deviceStates.set(name, payload);
      this.deviceSeenAt.set(name, Date.now());
      const ieee = deviceNameToIeee.get(`${this.id}:${name}`);
      if (ieee && deviceIndex.has(ieee)) {
        const entry = deviceIndex.get(ieee);
        if (typeof payload.linkquality === "number") {
          entry.linkquality = payload.linkquality;
        }
        const pseudo = {
          friendly_name: name,
          availability: this.availability.get(name),
          last_seen: payload.last_seen,
          linkquality: payload.linkquality,
        };
        entry.online = isDeviceOnline(this, pseudo);
      }
      if (
        Object.prototype.hasOwnProperty.call(payload, "interview_completed") ||
        Object.prototype.hasOwnProperty.call(payload, "interview_state") ||
        Object.prototype.hasOwnProperty.call(payload, "interview_status")
      ) {
        updateMigrations();
      }
    }
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  if (req.url.startsWith("//")) {
    req.url = req.url.replace(/^\/+/, "/");
  }
  next();
});

app.get("/api/state", (req, res) => {
  try {
    const pairing = buildPairingStatus();
    const devices = buildDeviceList();
    const coordinators = buildCoordinatorList();
    res.json({
      generatedAt: nowIso(),
      overview: summarizeOverview(),
      pairing,
      migrationAvailable: pairing.length > 0,
      devices,
      coordinators,
      mappingsCount: Object.keys(mappings).length,
      backends: backends.map((backend) => ({
        id: backend.id,
        label: backend.label,
        connected: backend.connected,
      })),
    });
  } catch (error) {
    console.error("[API] state failed", error);
    res.status(500).json({ error: "Failed to build state" });
  }
});

app.get("/api/logs", (req, res) => {
  try {
    pruneActivity();
    res.json({
      logs: recentActivity,
    });
  } catch (error) {
    console.error("[API] logs failed", error);
    res.status(500).json({ error: "Failed to load logs" });
  }
});

app.post("/api/mappings", (req, res) => {
  const { ieee, name } = req.body || {};
  logUiAction("mapping_save", { ieee });
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Missing device name" });
    return;
  }
  const existing = mappings[ieee] || {};
  mappings[ieee] = {
    ...existing,
    name: name.trim(),
    updatedAt: nowIso(),
  };
  saveMappings();
  res.json({ ok: true });
});

app.delete("/api/mappings/:ieee", (req, res) => {
  const ieee = req.params.ieee;
  logUiAction("mapping_delete", { ieee });
  if (!mappings[ieee]) {
    res.status(404).json({ error: "Mapping not found" });
    return;
  }
  delete mappings[ieee];
  saveMappings();
  res.json({ ok: true });
});

app.post("/api/mappings/delete-offline", (req, res) => {
  const { ieee } = req.body || {};
  logUiAction("mapping_delete_offline", { ieee });
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const entry = deviceIndex.get(ieee);
  if (entry && entry.online) {
    res.status(400).json({ error: "Device is online" });
    return;
  }
  if (mappings[ieee]) {
    delete mappings[ieee];
    saveMappings();
  }
  if (installCodes[ieee]) {
    delete installCodes[ieee];
    saveInstallCodes();
  }
  res.json({ ok: true });
});

app.post("/api/install-codes", (req, res) => {
  const { ieee, code } = req.body || {};
  logUiAction("install_code_save", { ieee });
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) {
    delete installCodes[ieee];
    saveInstallCodes();
    res.json({ ok: true });
    return;
  }
  installCodes[ieee] = trimmed;
  saveInstallCodes();
  res.json({ ok: true });
});

app.post("/api/install-codes/apply", (req, res) => {
  const { ieee, backendId, code } = req.body || {};
  logUiAction("install_code_apply", { ieee, backendId });
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  if (!backendId || typeof backendId !== "string") {
    res.status(400).json({ error: "Missing backend id" });
    return;
  }
  const target = backends.find((backend) => backend.id === backendId);
  if (!target) {
    res.status(404).json({ error: "Backend not found" });
    return;
  }
  const trimmed = typeof code === "string" ? code.trim() : "";
  const stored = installCodes[ieee] || "";
  const finalCode = trimmed || stored;
  if (!finalCode) {
    res.status(400).json({ error: "Missing install code" });
    return;
  }
  installCodes[ieee] = finalCode;
  saveInstallCodes();
  sendInstallCodeAdd(target, ieee, finalCode, "install_code_apply_click");
  pushActivity({
    time: nowIso(),
    type: "log",
    message: `${target.label} - Install code applied for ${ieee}`,
  });
  res.json({ ok: true });
});

app.get("/api/ha/device", async (req, res) => {
  const ieee = typeof req.query.ieee === "string" ? req.query.ieee.trim() : "";
  if (!ieee) {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const { url, token } = getHaConfig();
  if (!url || !token) {
    res.status(400).json({ error: "Home Assistant is not configured" });
    return;
  }
  try {
    const info = await buildHaDeviceInfo(ieee);
    res.json({ ok: true, info, haUrl: url });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load HA device info" });
  }
});

app.post("/api/ha/snapshot", async (req, res) => {
  const { ieee } = req.body || {};
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const { url, token } = getHaConfig();
  if (!url || !token) {
    res.status(400).json({ error: "Home Assistant is not configured" });
    return;
  }
  try {
    const snapshot = await saveHaSnapshotForIeee(ieee);
    res.json({ ok: true, snapshot });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to save HA snapshot" });
  }
});

app.post("/api/ha/restore-entity-ids", async (req, res) => {
  const { ieee } = req.body || {};
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const { url, token } = getHaConfig();
  if (!url || !token) {
    res.status(400).json({ error: "Home Assistant is not configured" });
    return;
  }
  try {
    const result = await restoreHaEntityIds(ieee);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to restore entity IDs" });
  }
});

app.post("/api/ha/automations/preview", async (req, res) => {
  const { url, token } = getHaConfig();
  if (!url || !token) {
    res.status(400).json({ error: "Home Assistant is not configured" });
    return;
  }
  try {
    const result = await previewAutomationRewrite();
    res.json({ ok: true, result, haUrl: url });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to preview automations" });
  }
});

app.post("/api/ha/automations/rewrite", async (req, res) => {
  const { url, token } = getHaConfig();
  if (!url || !token) {
    res.status(400).json({ error: "Home Assistant is not configured" });
    return;
  }
  try {
    const result = await applyAutomationRewrite();
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to rewrite automations" });
  }
});

app.post("/api/ha/automations/rewrite-device", async (req, res) => {
  const { ieee } = req.body || {};
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const { url, token } = getHaConfig();
  if (!url || !token) {
    res.status(400).json({ error: "Home Assistant is not configured" });
    return;
  }
  try {
    const result = await applyAutomationRewriteForDevice(ieee);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to rewrite automations for device" });
  }
});

app.post("/api/ha/automations/preview-device", async (req, res) => {
  const { ieee } = req.body || {};
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const { url, token } = getHaConfig();
  if (!url || !token) {
    res.status(400).json({ error: "Home Assistant is not configured" });
    return;
  }
  try {
    const result = await previewAutomationRewriteForDevice(ieee);
    res.json({ ok: true, result, haUrl: url });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to preview automations for device" });
  }
});

app.post("/api/coordinators/accept", (req, res) => {
  const { backendId } = req.body || {};
  if (!backendId || typeof backendId !== "string") {
    res.status(400).json({ error: "Missing backend id" });
    return;
  }
  const backend = backends.find((entry) => entry.id === backendId);
  if (!backend || !backend.bridgeInfo || !backend.bridgeInfo.coordinator) {
    res.status(404).json({ error: "Coordinator not found" });
    return;
  }
  const info = backend.bridgeInfo;
  const revision = getCoordinatorRevision(info.coordinator.meta || {});
  coordinatorSnapshots[backendId] = {
    ieee: info.coordinator.ieee_address || "",
    type: info.coordinator.type || "",
    revision: revision || "",
    serialPort: info.config?.serial?.port || "",
    adapter: info.config?.serial?.adapter || "",
    savedAt: nowIso(),
  };
  saveCoordinatorSnapshots();
  res.json({ ok: true });
});

app.post("/api/coordinators/accept-all", (req, res) => {
  let saved = 0;
  for (const backend of backends) {
    if (!backend.bridgeInfo || !backend.bridgeInfo.coordinator) {
      continue;
    }
    const info = backend.bridgeInfo;
    const revision = getCoordinatorRevision(info.coordinator.meta || {});
    coordinatorSnapshots[backend.id] = {
      ieee: info.coordinator.ieee_address || "",
      type: info.coordinator.type || "",
      revision: revision || "",
      serialPort: info.config?.serial?.port || "",
      adapter: info.config?.serial?.adapter || "",
      savedAt: nowIso(),
    };
    saved += 1;
  }
  saveCoordinatorSnapshots();
  res.json({ ok: true, saved });
});

app.post("/api/pairing", (req, res) => {
  const { backendId, enable } = req.body || {};
  logUiAction(enable ? "pairing_enable" : "pairing_disable", { backendId });
  if (!backendId || typeof backendId !== "string") {
    res.status(400).json({ error: "Missing backend id" });
    return;
  }
  const backend = backends.find((entry) => entry.id === backendId);
  if (!backend) {
    res.status(404).json({ error: "Backend not found" });
    return;
  }
  const time = enable ? 240 : 0;
  sendPermitJoin(backend, time, enable ? "pairing_enable_click" : "pairing_disable_click");
  pushActivity({
    time: nowIso(),
    type: "migration",
    message: `${backend.label} - Pairing command sent (${enable ? "enable 4 min" : "disable"})`,
  });
  res.json({ ok: true, label: backend.label });
});

app.post("/api/reset", (req, res) => {
  logUiAction("reset_mappings");
  mappings = {};
  try {
    fs.unlinkSync(MAP_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to remove mapping file", error);
    }
  }
  rebuildDeviceIndex();
  res.json({ ok: true });
});

app.post("/api/mappings/apply", (req, res) => {
  logUiAction("mappings_apply_scan");
  const mismatches = [];
  for (const [ieee, mapping] of Object.entries(mappings)) {
    const desired = mapping && mapping.name ? mapping.name.trim() : "";
    if (!desired) {
      continue;
    }
    const entry = deviceIndex.get(ieee);
    if (!entry) {
      continue;
    }
    for (const backend of backends) {
      const current = entry.namesByBackend[backend.id];
      if (!current || current === desired) {
        continue;
      }
      mismatches.push({
        ieee,
        backendId: backend.id,
        backendLabel: backend.label,
        current,
        desired,
      });
    }
  }
  res.json({ ok: true, mismatches });
});

app.post("/api/mappings/apply-one", (req, res) => {
  const { ieee, backendId } = req.body || {};
  logUiAction("mappings_apply_one", { ieee, backendId });
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  if (!backendId || typeof backendId !== "string") {
    res.status(400).json({ error: "Missing backend id" });
    return;
  }
  const mapping = mappings[ieee];
  const desired = mapping && mapping.name ? mapping.name.trim() : "";
  if (!desired) {
    res.status(400).json({ error: "Missing mapping name" });
    return;
  }
  const entry = deviceIndex.get(ieee);
  if (!entry) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  const backend = backends.find((item) => item.id === backendId);
  if (!backend) {
    res.status(404).json({ error: "Backend not found" });
    return;
  }
  const current = entry.namesByBackend[backend.id];
  if (!current || current === desired) {
    res.json({ ok: true, applied: false });
    return;
  }
  sendRename(backend, current, desired, "mappings_apply_one_click");
  pushActivity({
    time: nowIso(),
    type: "rename",
    message: `${backend.label} - Rename command sent: ${current} -> ${desired}`,
  });
  scheduleHaRestore(ieee, "manual-rename");
  res.json({ ok: true, applied: true });
});

app.post("/api/mappings/rename-to", (req, res) => {
  const { ieee } = req.body || {};
  logUiAction("mappings_rename_to", { ieee });
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const mapping = mappings[ieee];
  const desired = mapping && mapping.name ? mapping.name.trim() : "";
  if (!desired) {
    res.status(400).json({ error: "Missing mapping name" });
    return;
  }
  const entry = deviceIndex.get(ieee);
  if (!entry) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  let sent = 0;
  for (const backend of backends) {
    const current = entry.namesByBackend[backend.id];
    if (!current || current === desired) {
      continue;
    }
    sendRename(backend, current, desired, "mappings_rename_to_click");
    pushActivity({
      time: nowIso(),
      type: "rename",
      message: `${backend.label} - Rename command sent: ${current} -> ${desired}`,
    });
    sent += 1;
  }
  if (sent > 0) {
    scheduleHaRestore(ieee, "manual-rename");
  }
  res.json({ ok: true, sent });
});

const requestRemoval = (ieee) => {
  return new Promise((resolve) => {
    if (pendingRemovals.has(ieee)) {
      resolve({ status: "pending" });
      return;
    }

    const entry = deviceIndex.get(ieee);
    if (!entry) {
      pushActivity({
        time: nowIso(),
        type: "log",
        message: `Remove ignored: device ${ieee} not found`,
      });
      resolve({ status: "not_found" });
      return;
    }

    for (const backend of backends) {
      if (entry.namesByBackend[backend.id]) {
        sendRemove(backend, ieee, false, "remove_click");
        pushActivity({
          time: nowIso(),
          type: "migration",
          message: `${backend.label} - Remove command sent for ${ieee}`,
        });
      }
    }

    const timeout = setTimeout(() => {
      pendingRemovals.delete(ieee);
      pushActivity({
        time: nowIso(),
        type: "log",
        message: `Remove timeout for ${ieee}`,
      });
      resolve({ status: "timeout" });
    }, REMOVE_TIMEOUT_MS);

    pendingRemovals.set(ieee, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
    });
  });
};

const startMigration = (ieee, force) => {
  const existing = pendingMigrations.get(ieee);
  if (existing) {
    const elapsed = Date.now() - existing.startedAt;
    if (elapsed < 5000) {
      pushActivity({
        time: nowIso(),
        type: "log",
        message: `Migration ignored for ${ieee}: already requested recently`,
      });
      return { status: "recent" };
    }
    pendingMigrations.delete(ieee);
  }
  const entry = deviceIndex.get(ieee);
  if (!entry) {
    pushActivity({
      time: nowIso(),
      type: "log",
      message: `Migration ignored for ${ieee}: device not found`,
    });
    return { status: "not_found" };
  }
  const pairingBackend = getActivePairingBackend();
  if (pairingBackend && entry.namesByBackend && entry.namesByBackend[pairingBackend.id]) {
    pushActivity({
      time: nowIso(),
      type: "log",
      message: `Migration blocked for ${ieee}: pairing active on source backend ${pairingBackend.label}`,
    });
    return { status: "blocked_pairing" };
  }
  const installCode = installCodes[ieee];
  if (installCode) {
    const target = getActivePairingBackend();
    if (target) {
      sendInstallCodeAdd(target, ieee, installCode, "auto_before_migration");
      pushActivity({
        time: nowIso(),
        type: "migration",
        message: `${target.label} - Install code applied for ${ieee}`,
      });
    }
  }
  const sourceBackends = backends.filter((backend) => entry.namesByBackend[backend.id]);
  if (sourceBackends.length === 0) {
    pushActivity({
      time: nowIso(),
      type: "log",
      message: `Migration ignored for ${ieee}: no source backend assigned`,
    });
    return { status: "not_found" };
  }
  const sourceLabels = sourceBackends.map((backend) => backend.label);
  pendingMigrations.set(ieee, {
    ieee,
    force: !!force,
    startedAt: Date.now(),
    sourceBackendIds: sourceBackends.map((backend) => backend.id),
    sourceLabels,
    leftOld: false,
    targetBackendId: null,
    configuring: false,
    configured: false,
    renameSent: false,
    blocklistRemoved: false,
  });
  pushActivity({
    time: nowIso(),
    type: "migration",
    message: `Migration started for ${ieee}${force ? " (force)" : ""}`,
  });

  for (const backend of sourceBackends) {
    sendRemove(backend, ieee, !!force, force ? "force_migration_start" : "migration_start");
    pushActivity({
      time: nowIso(),
      type: "migration",
      message: `${backend.label} - Remove command sent for ${ieee}${force ? " (force)" : ""}`,
    });
  }
  if (force) {
    for (const backend of sourceBackends) {
      sendBlocklistAdd(backend, ieee, "force_migration_start");
      pushActivity({
        time: nowIso(),
        type: "migration",
        message: `${backend.label} - Blocklist add command sent for ${ieee}`,
      });
    }
  }
  return { status: "started" };
};

app.post("/api/migrate", async (req, res) => {
  const { ieee } = req.body || {};
  logUiAction("migrate", { ieee });
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const { url, token } = getHaConfig();
  if (url && token) {
    try {
      await saveHaSnapshotForIeee(ieee);
    } catch (error) {
      res.status(500).json({ error: `HA snapshot failed: ${error.message}` });
      return;
    }
  }
  res.json(startMigration(ieee, false));
});

app.post("/api/migrate/force", async (req, res) => {
  const { ieee } = req.body || {};
  logUiAction("migrate_force", { ieee });
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const { url, token } = getHaConfig();
  if (url && token) {
    try {
      await saveHaSnapshotForIeee(ieee);
    } catch (error) {
      res.status(500).json({ error: `HA snapshot failed: ${error.message}` });
      return;
    }
  }
  res.json(startMigration(ieee, true));
});

app.post("/api/remove", async (req, res) => {
  const { ieee } = req.body || {};
  logUiAction("remove", { ieee });
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const result = await requestRemoval(ieee);
  res.json(result);
});

const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

const startServer = () => {
  loadOptions();
  if (optionsValidationErrors.length > 0) {
    throw new Error(`Invalid add-on options: ${optionsValidationErrors.join(" ")}`);
  }
  loadMappings();
  loadInstallCodes();
  loadHaSnapshots();
  loadCoordinatorSnapshots();

  const server = http.createServer(app);
  server.listen(LISTEN_PORT, () => {
    console.log(`Zigbee2MQTT Migration tool listening on ${LISTEN_PORT}`);
  });

  backends = buildBackends().map((config) => new Backend(config));
  for (const backend of backends) {
    backend.connect();
  }

  if (backends.length === 0) {
    console.warn("No backends configured. Set server_x and matching label_x in options.");
  }

  setInterval(() => {
    processHaRestores();
  }, 5000);

  setInterval(() => {
    backends.forEach((backend) => {
      backend.requestDevices();
    });
  }, DEVICE_REFRESH_MS);

  return server;
};

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
};
