const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");

const OPTIONS_PATH = "/data/options.json";
const MAP_PATH = "/data/ieee-map.json";
const LISTEN_PORT = 8104;
const RECONNECT_DELAY_MS = 5000;
const MAX_ACTIVITY_ENTRIES = 250;
const ACTIVITY_TTL_MS = 3 * 60 * 1000;
const LAST_SEEN_ONLINE_MS = 10 * 60 * 1000;
const RENAME_COOLDOWN_MS = 60000;
const REMOVE_TIMEOUT_MS = 15000;

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
const recentActivity = [];
const pendingRenames = new Map();
const pendingRemovals = new Map();

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
          model: device.model_id || "",
          type: normalizeDeviceType(device),
          online: false,
          interviewCompleted: device.interview_completed !== false,
          linkquality: typeof device.linkquality === "number" ? device.linkquality : null,
        };
        nextIndex.set(ieee, entry);
      }
      entry.instances.push(backend.label);
      entry.namesByBackend[backend.id] = device.friendly_name;
      entry.model = entry.model || device.model_id || "";
      entry.type = entry.type !== "Unknown" ? entry.type : normalizeDeviceType(device);
      entry.online = entry.online || isDeviceOnline(backend, device);
      entry.interviewCompleted = entry.interviewCompleted && device.interview_completed !== false;
      if (typeof device.linkquality === "number") {
        entry.linkquality = device.linkquality;
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
  scheduleAutoRename();
};

const resolveRemovals = () => {
  for (const [ieee, pending] of pendingRemovals.entries()) {
    if (!deviceIndex.has(ieee)) {
      pending.resolve({ status: "removed" });
      pendingRemovals.delete(ieee);
    }
  }
};

const scheduleAutoRename = () => {
  for (const [ieee, entry] of deviceIndex.entries()) {
    const mapping = mappings[ieee];
    if (!mapping || !mapping.name) {
      continue;
    }
    if (!entry.interviewCompleted) {
      continue;
    }
    const currentName = firstKnownName(entry);
    if (!currentName || currentName === mapping.name) {
      continue;
    }
    const pending = pendingRenames.get(ieee);
    const now = Date.now();
    if (pending && pending.name === mapping.name && now - pending.lastAttempt < RENAME_COOLDOWN_MS) {
      continue;
    }
    const backendId = firstBackendId(entry);
    if (!backendId) {
      continue;
    }
    const backend = backends.find((candidate) => candidate.id === backendId);
    if (!backend) {
      continue;
    }

    sendRename(backend, currentName, mapping.name);
    pendingRenames.set(ieee, { name: mapping.name, lastAttempt: now });
  }
};

const firstKnownName = (entry) => {
  const backendIds = Object.keys(entry.namesByBackend || {});
  if (backendIds.length === 0) {
    return "";
  }
  return entry.namesByBackend[backendIds[0]];
};

const firstBackendId = (entry) => {
  const backendIds = Object.keys(entry.namesByBackend || {});
  return backendIds[0] || null;
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
    combined.push({
      ieee,
      mappedName: mapping.name || "",
      instances: entry ? entry.instances : [],
      model: entry ? entry.model : "",
      type: entry ? entry.type : "Unknown",
      online: entry ? entry.online : false,
      interviewCompleted: entry ? entry.interviewCompleted : false,
      linkquality: entry ? entry.linkquality : null,
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

const sendRemove = (backend, ieee) => {
  backend.send({
    topic: "bridge/request/device/remove",
    payload: {
      id: ieee,
      force: false,
    },
  });
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
      return;
    }

    if (data.topic.startsWith("bridge/")) {
      switch (data.topic) {
        case "bridge/devices":
          this.devicesRaw = Array.isArray(data.payload) ? data.payload : [];
          console.log(`[${this.label}] bridge/devices ${this.devicesRaw.length}`);
          rebuildDeviceIndex();
          return;
        case "bridge/info":
          this.bridgeInfo = data.payload || null;
          if (this.bridgeInfo && typeof this.bridgeInfo.permit_join_timeout === "number") {
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
    }
  }
}

loadMappings();

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
  scheduleAutoRename();
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
        sendRemove(backend, ieee);
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

app.post("/api/migrate", async (req, res) => {
  const { ieee } = req.body || {};
  if (!ieee || typeof ieee !== "string") {
    res.status(400).json({ error: "Missing IEEE address" });
    return;
  }
  const result = await requestRemoval(ieee);
  res.json(result);
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
