const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");

const OPTIONS_PATH = "/data/options.json";
const MAP_PATH = "/data/ieee-map.json";
const INSTALL_CODES_PATH = "/data/install-codes.json";
const LISTEN_PORT = 8104;
const RECONNECT_DELAY_MS = 5000;
const MAX_ACTIVITY_ENTRIES = 250;
const ACTIVITY_TTL_MS = 3 * 60 * 1000;
const LAST_SEEN_ONLINE_MS = 10 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 15000;
const MIGRATION_TTL_MS = 60 * 60 * 1000;

const readOptions = () => {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8"));
  } catch (error) {
    console.error("Failed to read options.json, using defaults.", error);
    return {};
  }
};

const options = readOptions();

const buildBackends = () => {
  const candidates = [
    {
      id: "one",
      label: options.label_one || "One",
      url: options.server_one,
      token: options.auth_token_one,
    },
    {
      id: "two",
      label: options.label_two || "Two",
      url: options.server_two,
      token: options.auth_token_two,
    },
    {
      id: "three",
      label: options.label_three || "Three",
      url: options.server_three,
      token: options.auth_token_three,
    },
    {
      id: "four",
      label: !options.label_four || options.label_four === "Four" ? "Original" : options.label_four,
      url: options.server_four,
      token: options.auth_token_four,
    },
  ];

  return candidates.filter((entry) => !!entry.url);
};

const buildWsUrl = (url, token) => {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = path.posix.join(parsed.pathname || "/", "api");
  if (token) {
    parsed.searchParams.set("token", token);
  }
  return parsed.toString();
};

let mappings = {};
let backends = [];
let deviceIndex = new Map();
const deviceNameToIeee = new Map();
let installCodes = {};
const recentActivity = [];
const pendingRemovals = new Map();
const pendingMigrations = new Map();

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

const normalizeDeviceType = (device) => {
  if (!device || !device.type) {
    return "Unknown";
  }
  if (device.type === "Router") {
    return "Router";
  }
  if (device.type === "EndDevice") {
    return "End device";
  }
  return device.type;
};

const isInterviewCompleteDevice = (device, backend) => {
  if (!device || typeof device !== "object") {
    return false;
  }
  if (device.interview_completed === true) {
    return true;
  }
  if (device.interview_state === "successful" || device.interview_status === "successful") {
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
  if (state.interview_state === "successful" || state.interview_status === "successful") {
    return true;
  }
  return false;
};

const isDeviceOnline = (backend, device) => {
  if (device && device.availability && typeof device.availability === "object") {
    const state = device.availability.state;
    if (typeof state === "string") {
      return state.toLowerCase() === "online";
    }
    if (typeof device.availability === "string") {
      return device.availability.toLowerCase() === "online";
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

      if (!mappings[ieee]) {
        mappings[ieee] = {
          name: device.friendly_name,
          updatedAt: nowIso(),
        };
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
      active.push({ label: backend.label, remaining });
    }
  }
  return active;
};

const buildDeviceList = () => {
  const combined = [];
  const seen = new Set();

  for (const ieee of Object.keys(mappings)) {
    seen.add(ieee);
  }
  for (const ieee of deviceIndex.keys()) {
    seen.add(ieee);
  }

  for (const ieee of seen) {
    const mapping = mappings[ieee] || { name: "" };
    const entry = deviceIndex.get(ieee);
    const mappingName = mapping.name ? mapping.name.trim() : "";
    const currentName = entry ? firstKnownName(entry) : "";
    const nameMismatch =
      !!entry &&
      !!mappingName &&
      Object.values(entry.namesByBackend || {}).some((name) => name && name !== mappingName);
    combined.push({
      ieee,
      mappedName: mappingName,
      currentName,
      nameMismatch,
      instances: entry ? entry.instances : [],
      model: entry ? entry.model : "",
      vendor: entry ? entry.vendor : "",
      modelId: entry ? entry.modelId : "",
      supported: entry ? entry.supported : false,
      type: entry ? entry.type : "Unknown",
      online: entry ? entry.online : false,
      interviewCompleted: entry ? entry.interviewCompleted : false,
      linkquality: entry ? entry.linkquality : null,
      installCode: installCodes[ieee] || "",
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

const sendRename = (backend, fromName, toName) => {
  backend.send({
    topic: "bridge/request/device/rename",
    payload: {
      from: fromName,
      to: toName,
      homeassistant_rename: false,
    },
  });
};

const sendRemove = (backend, ieee, force) => {
  backend.send({
    topic: "bridge/request/device/remove",
    payload: {
      id: ieee,
      force: !!force,
    },
  });
};

const sendBlocklistAdd = (backend, ieee) => {
  backend.send({
    topic: "bridge/request/device/blocklist/add",
    payload: {
      ieee_address: ieee,
    },
  });
};

const sendBlocklistRemove = (backend, ieee) => {
  backend.send({
    topic: "bridge/request/device/blocklist/remove",
    payload: {
      ieee_address: ieee,
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

      if (migration.force && migration.configured && !migration.renameSent && target && device) {
        const mapping = mappings[ieee];
        const desired = mapping && mapping.name ? mapping.name.trim() : "";
        const current = device.friendly_name;
        if (desired && current && desired !== current) {
          sendRename(target, current, desired);
          pushActivity({
            time: nowIso(),
            type: "rename",
            message: `${target.label} - Rename command sent: ${current} -> ${desired}`,
          });
        }
        migration.renameSent = true;
      }

      if (migration.force && migration.configured && !migration.blocklistRemoved) {
        for (const backend of sourceBackends) {
          sendBlocklistRemove(backend, ieee);
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
            const time = data.payload.time;
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

loadMappings();
loadInstallCodes();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  if (req.url.startsWith("//")) {
    const original = req.url;
    req.url = req.url.replace(/^\/+/, "/");
    console.log(`[HTTP] normalized ${original} -> ${req.url}`);
  }
  next();
});
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

app.get("/api/state", (req, res) => {
  try {
    const pairing = buildPairingStatus();
    const devices = buildDeviceList();
    res.json({
      generatedAt: nowIso(),
      overview: summarizeOverview(),
      pairing,
      migrationAvailable: pairing.length > 0,
      devices,
      mappingsCount: Object.keys(mappings).length,
      backends: backends.map((backend) => ({
        id: backend.id,
        label: backend.label,
        connected: backend.connected,
      })),
    });
    console.log(
      `[API] state ok (devices=${devices.length} mappings=${Object.keys(mappings).length} pairing=${pairing.length})`,
    );
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
    console.log(`[API] logs ok (entries=${recentActivity.length})`);
  } catch (error) {
    console.error("[API] logs failed", error);
    res.status(500).json({ error: "Failed to load logs" });
  }
});

app.post("/api/mappings", (req, res) => {
  const { ieee, name } = req.body || {};
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Missing device name" });
    return;
  }
  mappings[ieee] = {
    name: name.trim(),
    updatedAt: nowIso(),
  };
  saveMappings();
  res.json({ ok: true });
});

app.delete("/api/mappings/:ieee", (req, res) => {
  const ieee = req.params.ieee;
  if (!mappings[ieee]) {
    res.status(404).json({ error: "Mapping not found" });
    return;
  }
  delete mappings[ieee];
  saveMappings();
  res.json({ ok: true });
});

app.post("/api/install-codes", (req, res) => {
  const { ieee, code } = req.body || {};
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
  target.send({
    topic: "bridge/request/install_code/add",
    payload: {
      value: finalCode,
      label: ieee,
    },
  });
  pushActivity({
    time: nowIso(),
    type: "log",
    message: `${target.label} - Install code applied for ${ieee}`,
  });
  res.json({ ok: true });
});

app.post("/api/reset", (req, res) => {
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
  sendRename(backend, current, desired);
  pushActivity({
    time: nowIso(),
    type: "rename",
    message: `${backend.label} - Rename command sent: ${current} -> ${desired}`,
  });
  res.json({ ok: true, applied: true });
});

app.post("/api/mappings/rename-to", (req, res) => {
  const { ieee } = req.body || {};
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
    sendRename(backend, current, desired);
    pushActivity({
      time: nowIso(),
      type: "rename",
      message: `${backend.label} - Rename command sent: ${current} -> ${desired}`,
    });
    sent += 1;
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
      resolve({ status: "not_found" });
      return;
    }

    for (const backend of backends) {
      if (entry.namesByBackend[backend.id]) {
        sendRemove(backend, ieee, false);
      }
    }

    const timeout = setTimeout(() => {
      pendingRemovals.delete(ieee);
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
  if (pendingMigrations.has(ieee)) {
    return { status: "pending" };
  }
  const entry = deviceIndex.get(ieee);
  if (!entry) {
    return { status: "not_found" };
  }
  const sourceBackends = backends.filter((backend) => entry.namesByBackend[backend.id]);
  if (sourceBackends.length === 0) {
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

  for (const backend of sourceBackends) {
    sendRemove(backend, ieee, !!force);
    pushActivity({
      time: nowIso(),
      type: "migration",
      message: `${backend.label} - Remove command sent for ${ieee}${force ? " (force)" : ""}`,
    });
  }
  if (force) {
    for (const backend of sourceBackends) {
      sendBlocklistAdd(backend, ieee);
      pushActivity({
        time: nowIso(),
        type: "migration",
        message: `${backend.label} - Blocklist add command sent for ${ieee}`,
      });
    }
  }
  return { status: "started" };
};

app.post("/api/migrate", (req, res) => {
  const { ieee } = req.body || {};
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  res.json(startMigration(ieee, false));
});

app.post("/api/migrate/force", (req, res) => {
  const { ieee } = req.body || {};
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  res.json(startMigration(ieee, true));
});

app.post("/api/remove", async (req, res) => {
  const { ieee } = req.body || {};
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

const server = http.createServer(app);
server.listen(LISTEN_PORT, () => {
  console.log(`Zigbee2MQTT Migration tool listening on ${LISTEN_PORT}`);
});

backends = buildBackends().map((config) => new Backend(config));
for (const backend of backends) {
  backend.connect();
}

if (backends.length === 0) {
  console.warn("No backends configured. Set server_one/server_two/server_three in options.");
}
