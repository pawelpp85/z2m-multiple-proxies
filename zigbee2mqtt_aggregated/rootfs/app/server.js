const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const expressStaticGzip = require("express-static-gzip");
const WebSocket = require("ws");
const FRONTEND_PACKAGE = "zigbee2mqtt-windfront";

const OPTIONS_PATH = "/data/options.json";
const LISTEN_PORT = 8102;
const RECONNECT_DELAY_MS = 5000;
const LOG_SUMMARY_INTERVAL_MS = 30000;

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

let backends = [];
const clients = new Set();
const deviceNameLookup = new Map();
const deviceIeeeLookup = new Map();
const groupNameLookup = new Map();

const labelPrefix = (label) => `${label} - `;
const prefixName = (backend, name) => `${backend.label} - ${name}`;
const stripPrefix = (backend, name) => {
  const prefix = labelPrefix(backend.label);
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
};

const findBackendByPrefix = (name) => {
  return backends.find((backend) => name.startsWith(labelPrefix(backend.label))) || null;
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

const broadcast = (message) => {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
};

const updateDeviceLookup = () => {
  deviceNameLookup.clear();
  deviceIeeeLookup.clear();
  for (const backend of backends) {
    if (!backend.devicesRaw) {
      continue;
    }
    for (const device of backend.devicesRaw) {
      const prefixed = prefixName(backend, device.friendly_name);
      deviceNameLookup.set(prefixed, { backend, original: device.friendly_name });
      if (device.ieee_address) {
        deviceIeeeLookup.set(device.ieee_address, { backend, original: device.ieee_address });
      }
    }
  }
};

const updateGroupLookup = () => {
  groupNameLookup.clear();
  for (const backend of backends) {
    if (!backend.groupsRaw) {
      continue;
    }
    for (const group of backend.groupsRaw) {
      const prefixed = prefixName(backend, group.friendly_name);
      groupNameLookup.set(prefixed, { backend, original: group.friendly_name });
    }
  }
};

const aggregatedDevices = () => {
  const devices = [];
  for (const backend of backends) {
    if (!backend.devicesRaw) {
      continue;
    }
    for (const device of backend.devicesRaw) {
      devices.push({ ...device, friendly_name: prefixName(backend, device.friendly_name) });
    }
  }
  return devices;
};

const aggregatedGroups = () => {
  const groups = [];
  for (const backend of backends) {
    if (!backend.groupsRaw) {
      continue;
    }
    for (const group of backend.groupsRaw) {
      groups.push({ ...group, friendly_name: prefixName(backend, group.friendly_name) });
    }
  }
  return groups;
};

let lastBridgeInfo = null;
let lastBridgeDefinitions = null;
let lastBridgeExtensions = null;
let lastBridgeState = "offline";
let preferredBridgeInfoBackendId = null;
let networkMapBackendId = null;

const getBridgeInfoBackend = () => {
  if (preferredBridgeInfoBackendId) {
    const preferred = backends.find(
      (backend) => backend.id === preferredBridgeInfoBackendId && backend.bridgeInfo,
    );
    if (preferred) {
      return preferred;
    }
  }

  return getPrimaryBackend();
};

const getNetworkMapBackend = () => {
  const desired = (options.networkmap_backend || "").trim();
  if (desired) {
    const normalized = desired.toLowerCase();
    const direct = backends.find(
      (backend) => backend.id === normalized || backend.label.toLowerCase() === normalized,
    );
    if (direct) {
      return direct;
    }
    if (normalized === "auto") {
      return getBridgeInfoBackend();
    }
  }

  if (preferredBridgeInfoBackendId) {
    const preferred = backends.find((backend) => backend.id === preferredBridgeInfoBackendId);
    if (preferred) {
      return preferred;
    }
  }

  return getPrimaryBackend();
};

const getPrimaryBackend = () => {
  return (
    backends.find((backend) => backend.connected && backend.bridgeInfo) ||
    backends.find((backend) => backend.bridgeInfo) ||
    backends[0] ||
    null
  );
};

const updateBackendPermitJoin = (backend, time) => {
  if (!backend.bridgeInfo || typeof time !== "number") {
    return;
  }

  if (time > 0) {
    backend.bridgeInfo.permit_join = true;
    backend.bridgeInfo.permit_join_end = Date.now() + time * 1000;
  } else {
    backend.bridgeInfo.permit_join = false;
    backend.bridgeInfo.permit_join_end = undefined;
  }
};

const maybeBroadcastBridgeInfo = () => {
  const backend = getBridgeInfoBackend();
  if (!backend || !backend.bridgeInfo) {
    return;
  }
  const serialized = JSON.stringify(backend.bridgeInfo);
  if (serialized !== lastBridgeInfo) {
    lastBridgeInfo = serialized;
    broadcast({ topic: "bridge/info", payload: backend.bridgeInfo });
  }
};

const maybeBroadcastBridgeDefinitions = () => {
  const backend = getPrimaryBackend();
  if (!backend || !backend.bridgeDefinitions) {
    return;
  }
  const serialized = JSON.stringify(backend.bridgeDefinitions);
  if (serialized !== lastBridgeDefinitions) {
    lastBridgeDefinitions = serialized;
    broadcast({ topic: "bridge/definitions", payload: backend.bridgeDefinitions });
  }
};

const maybeBroadcastBridgeExtensions = () => {
  const backend = getPrimaryBackend();
  if (!backend || !backend.bridgeExtensions) {
    return;
  }
  const serialized = JSON.stringify(backend.bridgeExtensions);
  if (serialized !== lastBridgeExtensions) {
    lastBridgeExtensions = serialized;
    broadcast({ topic: "bridge/extensions", payload: backend.bridgeExtensions });
  }
};

const maybeBroadcastBridgeState = () => {
  const anyOnline = backends.some((backend) => backend.bridgeState === "online");
  const state = anyOnline ? "online" : "offline";
  if (state !== lastBridgeState) {
    lastBridgeState = state;
    broadcast({ topic: "bridge/state", payload: state });
  }
};

const broadcastAggregatedDevices = () => {
  updateDeviceLookup();
  broadcast({ topic: "bridge/devices", payload: aggregatedDevices() });
};

const broadcastAggregatedGroups = () => {
  updateGroupLookup();
  broadcast({ topic: "bridge/groups", payload: aggregatedGroups() });
};

const prefixDeviceTopic = (backend, topic) => {
  const parts = topic.split("/");
  const base = parts.shift();
  if (!base) {
    return topic;
  }
  return [prefixName(backend, base), ...parts].join("/");
};

const mapPayloadNames = (payload, backendHint, isGroupRequest) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { payload, backend: backendHint };
  }

  const mapped = { ...payload };
  const keys = ["id", "from", "to", "device", "group", "friendly_name"];
  let backend = backendHint;
  const ieeeRegex = /^0x[a-fA-F0-9]{16}$/;

  for (const key of keys) {
    if (typeof mapped[key] !== "string") {
      continue;
    }
    const name = mapped[key];
    if (ieeeRegex.test(name)) {
      const byIeee = deviceIeeeLookup.get(name);
      if (byIeee) {
        mapped[key] = byIeee.original;
        backend = backend || byIeee.backend;
        continue;
      }
    }
    const keyIsGroup = isGroupRequest ? key !== "device" : key === "group";
    const lookup = keyIsGroup ? groupNameLookup : deviceNameLookup;
    const byMap = lookup.get(name);
    if (byMap) {
      mapped[key] = byMap.original;
      backend = backend || byMap.backend;
      continue;
    }

    const byPrefix = findBackendByPrefix(name);
    if (byPrefix) {
      mapped[key] = stripPrefix(byPrefix, name);
      backend = backend || byPrefix;
    }
  }

  return { payload: mapped, backend };
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
    this.groupsRaw = null;
    this.deviceStates = new Map();
    this.availability = new Map();
    this.bridgeInfo = null;
    this.bridgeDefinitions = null;
    this.bridgeExtensions = null;
    this.bridgeState = "offline";
  }

  connect() {
    const wsUrl = buildWsUrl(this.url, this.token);
    console.log(`[${this.label}] Connecting to ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      this.connected = true;
      console.log(`[${this.label}] Connected`);
      maybeBroadcastBridgeState();
    });

    this.ws.on("message", (data) => {
      this.onMessage(data.toString());
    });

    this.ws.on("close", () => {
      this.connected = false;
      this.bridgeState = "offline";
      console.warn(`[${this.label}] Disconnected, retrying in ${RECONNECT_DELAY_MS}ms`);
      maybeBroadcastBridgeState();
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
      const prefixed = prefixName(this, base);
      this.availability.set(prefixed, data.payload);
      broadcast({ topic: `${prefixed}/availability`, payload: data.payload });
      return;
    }

    if (data.topic.startsWith("bridge/")) {
      switch (data.topic) {
        case "bridge/devices":
          this.devicesRaw = Array.isArray(data.payload) ? data.payload : [];
          console.log(`[${this.label}] bridge/devices ${this.devicesRaw.length}`);
          broadcastAggregatedDevices();
          return;
        case "bridge/groups":
          this.groupsRaw = Array.isArray(data.payload) ? data.payload : [];
          console.log(`[${this.label}] bridge/groups ${this.groupsRaw.length}`);
          broadcastAggregatedGroups();
          return;
        case "bridge/info":
          this.bridgeInfo = data.payload;
          maybeBroadcastBridgeInfo();
          return;
        case "bridge/definitions":
          this.bridgeDefinitions = data.payload;
          maybeBroadcastBridgeDefinitions();
          return;
        case "bridge/extensions":
          this.bridgeExtensions = data.payload;
          maybeBroadcastBridgeExtensions();
          return;
        case "bridge/state":
          this.bridgeState = data.payload;
          maybeBroadcastBridgeState();
          return;
        case "bridge/logging":
          if (data.payload && typeof data.payload.message === "string") {
            data.payload = {
              ...data.payload,
              message: `[${this.label}] ${data.payload.message}`,
            };
          }
          broadcast(data);
          return;
        default:
          if (data.topic === "bridge/response/permit_join") {
            const response = data.payload || {};
            if (response.status === "error") {
              updateBackendPermitJoin(this, 0);
              maybeBroadcastBridgeInfo();
            }
          }
          if (data.topic === "bridge/response/networkmap") {
            if (networkMapBackendId && this.id !== networkMapBackendId) {
              return;
            }
          }
          if (data.topic.startsWith("bridge/response/")) {
            broadcast(data);
          }
          return;
      }
    }

    const prefixedTopic = prefixDeviceTopic(this, data.topic);
    const baseName = prefixedTopic.split("/")[0];
    this.deviceStates.set(baseName, data.payload);
    broadcast({ topic: prefixedTopic, payload: data.payload });
  }
}

const start = async () => {
  const frontendModule = await import(FRONTEND_PACKAGE);
  const frontend = frontendModule.default || frontendModule;
  const frontendPath = frontend.getPath();

  backends = buildBackends().map((config) => new Backend(config));

  const app = express();
  const staticOptions = {
    enableBrotli: true,
    serveStatic: {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store");
        }
      },
    },
  };

  app.use(expressStaticGzip(frontendPath, staticOptions));

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ noServer: true });

  const sendInitialState = (ws) => {
    if (lastBridgeInfo) {
      ws.send(JSON.stringify({ topic: "bridge/info", payload: JSON.parse(lastBridgeInfo) }));
    }
    if (lastBridgeDefinitions) {
      ws.send(JSON.stringify({ topic: "bridge/definitions", payload: JSON.parse(lastBridgeDefinitions) }));
    }
    if (lastBridgeExtensions) {
      ws.send(JSON.stringify({ topic: "bridge/extensions", payload: JSON.parse(lastBridgeExtensions) }));
    }
    if (lastBridgeState) {
      ws.send(JSON.stringify({ topic: "bridge/state", payload: lastBridgeState }));
    }

    ws.send(JSON.stringify({ topic: "bridge/devices", payload: aggregatedDevices() }));
    ws.send(JSON.stringify({ topic: "bridge/groups", payload: aggregatedGroups() }));

    for (const backend of backends) {
      for (const [name, payload] of backend.deviceStates.entries()) {
        ws.send(JSON.stringify({ topic: name, payload }));
      }
      for (const [name, payload] of backend.availability.entries()) {
        ws.send(JSON.stringify({ topic: `${name}/availability`, payload }));
      }
    }
  };

  const handleClientMessage = (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      console.error("Invalid client message", error);
      return;
    }

    if (!message || !message.topic) {
      return;
    }

    const topic = message.topic;
    const payload = message.payload;

    if (topic === "bridge/request/networkmap") {
      const target = getNetworkMapBackend();
      if (!target) {
        console.warn("No backend available for networkmap", topic);
        return;
      }
      networkMapBackendId = target.id;
      target.send({ topic, payload });
      return;
    }

    if (topic.startsWith("bridge/request/")) {
      const isGroupRequest = topic.startsWith("bridge/request/group/");
      const { payload: mappedPayload, backend } = mapPayloadNames(payload, null, isGroupRequest);
      const target = backend || getPrimaryBackend();
      if (!target) {
        console.warn("No backend available for bridge request", topic);
        return;
      }

      if (topic === "bridge/request/permit_join") {
        preferredBridgeInfoBackendId = target.id;
        updateBackendPermitJoin(target, mappedPayload.time);
        maybeBroadcastBridgeInfo();
      }

      target.send({ topic, payload: mappedPayload });
      return;
    }

    const parts = topic.split("/");
    const base = parts[0];
    const deviceTarget = deviceNameLookup.get(base) || groupNameLookup.get(base);
    if (deviceTarget) {
      parts[0] = deviceTarget.original;
      const mappedTopic = parts.join("/");
      deviceTarget.backend.send({ topic: mappedTopic, payload });
      return;
    }

    const fallback = getPrimaryBackend();
    if (!fallback) {
      console.warn("No backend available for device message", topic);
      return;
    }
    fallback.send({ topic, payload });
  };

  server.on("upgrade", (request, socket, head) => {
    if (request.url && request.url.endsWith("/api")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`Frontend client connected (${clients.size} total)`);
    sendInitialState(ws);

    ws.on("message", (data) => handleClientMessage(data.toString()));
    ws.on("close", () => clients.delete(ws));
  });

  app.get("*", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });

  server.listen(LISTEN_PORT, () => {
    console.log(`Zigbee2MQTT Aggregated listening on ${LISTEN_PORT}`);
  });

  setInterval(() => {
    const deviceCount = aggregatedDevices().length;
    const groupCount = aggregatedGroups().length;
    console.log(`Aggregated totals: devices=${deviceCount} groups=${groupCount}`);
  }, LOG_SUMMARY_INTERVAL_MS);

  if (backends.length === 0) {
    console.warn("No backends configured. Set server_one/server_two/server_three in options.");
  }

  for (const backend of backends) {
    backend.connect();
  }
};

start().catch((error) => {
  console.error("Failed to start aggregated frontend", error);
  process.exit(1);
});
