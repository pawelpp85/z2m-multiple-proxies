const stateUrl = "api/state";
const logsUrl = "api/logs";

const elements = {
  pairingStatus: document.getElementById("pairingStatus"),
  pairingControl: document.getElementById("pairingControl"),
  overviewDevices: document.getElementById("overviewDevices"),
  overviewOnline: document.getElementById("overviewOnline"),
  overviewRouter: document.getElementById("overviewRouter"),
  overviewEnd: document.getElementById("overviewEnd"),
  overviewLqi: document.getElementById("overviewLqi"),
  deviceTable: document.getElementById("deviceTable"),
  coordinatorTable: document.getElementById("coordinatorTable"),
  coordinatorSaveAll: document.getElementById("coordinatorSaveAll"),
  activityLog: document.getElementById("activityLog"),
  mappingCount: document.getElementById("mappingCount"),
  toast: document.getElementById("toast"),
  deviceSearch: document.getElementById("deviceSearch"),
  resetMappings: document.getElementById("resetMappings"),
  applyMappings: document.getElementById("applyMappings"),
  instanceFilters: document.getElementById("instanceFilters"),
  qrScanner: document.getElementById("qrScanner"),
  qrVideo: document.getElementById("qrVideo"),
  qrClose: document.getElementById("qrClose"),
  mappingModal: document.getElementById("mappingModal"),
  mappingModalText: document.getElementById("mappingModalText"),
  mappingCancel: document.getElementById("mappingCancel"),
  mappingApply: document.getElementById("mappingApply"),
  haModal: document.getElementById("haModal"),
  haClose: document.getElementById("haClose"),
  haDeviceTitle: document.getElementById("haDeviceTitle"),
  haStatus: document.getElementById("haStatus"),
  haSnapshotInfo: document.getElementById("haSnapshotInfo"),
  haSnapshot: document.getElementById("haSnapshot"),
  haRestore: document.getElementById("haRestore"),
  haDeviceInfo: document.getElementById("haDeviceInfo"),
  haEntityInfo: document.getElementById("haEntityInfo"),
  haAutomationInfo: document.getElementById("haAutomationInfo"),
  haAutomationList: document.getElementById("haAutomationList"),
  haAutomationPreview: document.getElementById("haAutomationPreview"),
  haAutomationApply: document.getElementById("haAutomationApply"),
};

let lastState = null;
let toastTimeout = null;
let sortKey = "mappedName";
let sortDir = "asc";
let selectedInstances = new Set();
let lastLogs = [];
let scannerStream = null;
let scannerTarget = null;
let scannerTargetIeee = null;
let mappingQueue = [];
let mappingCurrent = null;
let isEditing = false;
let haModalIeee = null;
let haAutomationPreview = null;
let lastHaInfo = null;
let haBaseUrl = "";
const scanAvailable =
  "BarcodeDetector" in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
const openInstallEditors = new Set();
const installDrafts = new Map();
const storageKey = "z2m_migration_filters";

const loadFilters = () => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.search === "string") {
      elements.deviceSearch.value = parsed.search;
    }
    if (parsed && Array.isArray(parsed.instances)) {
      selectedInstances = new Set(parsed.instances);
    }
  } catch (error) {
    console.warn("Failed to load filters", error);
  }
};

const saveFilters = () => {
  const payload = {
    search: elements.deviceSearch.value || "",
    instances: [...selectedInstances],
  };
  localStorage.setItem(storageKey, JSON.stringify(payload));
};

const showToast = (message) => {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 2800);
};

const tooltip = document.getElementById("hoverTooltip");
let tooltipTimer = null;
let tooltipTarget = null;

const hideTooltip = () => {
  if (!tooltip) {
    return;
  }
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
  }
  tooltipTarget = null;
  tooltip.classList.remove("visible");
  tooltip.setAttribute("aria-hidden", "true");
};

const positionTooltip = (target) => {
  if (!tooltip || !target) {
    return;
  }
  const rect = target.getBoundingClientRect();
  const tipRect = tooltip.getBoundingClientRect();
  let top = rect.bottom + 10;
  if (top + tipRect.height > window.innerHeight - 8) {
    top = rect.top - tipRect.height - 10;
  }
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.left = `${Math.round(left)}px`;
};

const scheduleTooltip = (target) => {
  if (!tooltip || !target) {
    return;
  }
  const help = target.dataset.help;
  if (!help) {
    hideTooltip();
    return;
  }
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
  }
  tooltipTimer = setTimeout(() => {
    tooltip.textContent = help;
    tooltip.setAttribute("aria-hidden", "false");
    tooltip.classList.add("visible");
    requestAnimationFrame(() => positionTooltip(target));
  }, 1000);
};

const formatRemaining = (seconds) => {
  if (seconds === null || seconds === undefined) {
    return "";
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

const formatLastSeen = (value) => {
  if (!value) {
    return "";
  }
  const stamp = new Date(value);
  if (Number.isNaN(stamp.getTime())) {
    return "";
  }
  const now = new Date();
  const sameDay =
    stamp.getFullYear() === now.getFullYear() &&
    stamp.getMonth() === now.getMonth() &&
    stamp.getDate() === now.getDate();
  const options = { hour12: false };
  return sameDay
    ? stamp.toLocaleTimeString(undefined, options)
    : stamp.toLocaleString(undefined, options);
};

const renderPairing = (pairing) => {
  const body = elements.pairingStatus.querySelector(".status-body");
  elements.pairingStatus.classList.remove("single", "multi");
  if (!pairing || pairing.length === 0) {
    body.textContent = "Pairing is disabled";
    return;
  }
  const message = pairing
    .map((entry) => {
      const remaining = formatRemaining(entry.remaining);
      return remaining ? `${entry.label} (${remaining})` : entry.label;
    })
    .join(", ");
  if (pairing.length === 1) {
    elements.pairingStatus.classList.add("single");
    body.innerHTML = `Pairing enabled<br>${message}`;
  } else {
    elements.pairingStatus.classList.add("multi");
    body.innerHTML = `Pairing enabled<br>${message}`;
  }
};

const renderPairingControl = (pairing, backends) => {
  if (!elements.pairingControl) {
    return;
  }
  const active = (pairing || []).filter((entry) => entry && entry.id);
  if (active.length === 1) {
    const current = active[0];
    elements.pairingControl.innerHTML = `
      <div class="pairing-actions">
        <button
          class="secondary danger"
          data-action="pairing-disable"
          data-backend="${current.id}"
          data-help="Disable pairing on ${current.label}."
        >
          Disable pairing on ${current.label}
        </button>
        <button
          class="secondary danger icon-button"
          data-action="pairing-refresh"
          data-backend="${current.id}"
          data-help="Extend pairing on ${current.label} for another 4 minutes."
          aria-label="Extend pairing"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.3-5.7"></path>
            <path d="M20 5v6h-6"></path>
          </svg>
        </button>
      </div>
    `;
    return;
  }
  if (active.length > 1) {
    const buttons = active
      .map(
        (backend) => `
          <button class="secondary danger" data-action="pairing-disable" data-backend="${backend.id}" data-help="Disable pairing on ${backend.label}.">
            Disable pairing on ${backend.label}
          </button>
        `,
      )
      .join("");
    elements.pairingControl.innerHTML = `
      <div class="pairing-label">Pairing enabled on:</div>
      <div class="pairing-buttons">${buttons}</div>
    `;
    return;
  }
  const buttons = (backends || [])
    .map(
      (backend) => `
        <button class="secondary pairing-enable" data-action="pairing-enable" data-backend="${backend.id}" data-help="Enable pairing on ${backend.label} for 4 minutes.">
          ${backend.label}
        </button>
      `,
    )
    .join("");
  elements.pairingControl.innerHTML = `
    <div class="pairing-label">Enable pairing on:</div>
    <div class="pairing-buttons">${buttons}</div>
  `;
};

const renderOverview = (overview) => {
  elements.overviewDevices.textContent = overview.devices ?? "-";
  elements.overviewOnline.textContent = overview.online ?? "-";
  elements.overviewRouter.textContent = overview.router ?? "-";
  elements.overviewEnd.textContent = overview.endDevice ?? "-";
  elements.overviewLqi.textContent = overview.lowLqi ?? "-";
};

const flashButton = (button) => {
  if (!button) {
    return;
  }
  button.classList.remove("flash");
  void button.offsetWidth;
  button.classList.add("flash");
};

const sortDevices = (devices) => {
  const sorted = [...devices];
  sorted.sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    const getValue = (item) => {
      switch (sortKey) {
        case "mappedName":
          return item.mappedName || "";
        case "ieee":
          return item.ieee || "";
        case "installCode":
          return item.installCode || "";
        case "instances":
          return item.instances ? item.instances.join(", ") : "";
        case "type":
          return item.type || "";
        case "model":
          return item.model || item.modelId || "";
        case "lqi":
          return typeof item.linkquality === "number" ? item.linkquality : -1;
        case "online":
          return item.online ? 1 : 0;
        default:
          return "";
      }
    };
    const left = getValue(a);
    const right = getValue(b);
    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * dir;
    }
    return String(left).localeCompare(String(right)) * dir;
  });
  return sorted;
};

const filterDevices = (devices) => {
  const query = elements.deviceSearch.value.trim().toLowerCase();
  let filtered = devices;
  if (query) {
    filtered = filtered.filter(
      (device) =>
        device.mappedName.toLowerCase().includes(query) || device.ieee.toLowerCase().includes(query),
    );
  }
  if (selectedInstances.size > 0) {
    filtered = filtered.filter((device) => {
      if (!device.instances || device.instances.length === 0) {
        return true;
      }
      return device.instances.some((instance) => selectedInstances.has(instance));
    });
  }
  return filtered;
};

const renderTable = (devices, migrationAvailable, backends = []) => {
  const rows = [
    `<div class="row header">
      <button class="sort" data-sort="mappedName" data-help="Sort by mapped name. Click again to reverse.">
        Mapped name
      </button>
      <button class="sort" data-sort="ieee" data-help="Sort by IEEE address. Click again to reverse.">
        IEEE address
      </button>
      <button class="sort" data-sort="installCode" data-help="Sort by whether an install code is set.">
        Install code
      </button>
      <button class="sort" data-sort="instances" data-help="Sort by instance membership.">
        Instances
      </button>
      <button class="sort" data-sort="type" data-help="Sort by device type (router/end device).">
        Type
      </button>
      <button class="sort" data-sort="model" data-help="Sort by model name.">
        Model
      </button>
      <button class="sort" data-sort="lqi" data-help="Sort by linkquality (LQI).">
        LQI
      </button>
      <button class="sort" data-sort="online" data-help="Sort by online status.">
        Online
      </button>
      <div>Actions</div>
    </div>`,
  ];

  const filtered = filterDevices(devices);
  const sorted = sortDevices(filtered);

  const backendOptions = backends
    .map((backend) => `<option value="${backend.id}">${backend.label}</option>`)
    .join("");
  const normalizeModel = (value) => value.replace(/[/| |:]/g, "_");

  sorted.forEach((device) => {
    const hasInstances = device.instances && device.instances.length > 0;
    const instances = hasInstances ? device.instances.join(", ") : "Unassigned";
    const effectiveOnline = hasInstances ? device.online : false;
    const effectiveLabel = effectiveOnline ? "Online" : "Offline";
    const effectiveClass = effectiveOnline ? "" : "offline";
    const lqi = typeof device.linkquality === "number" ? device.linkquality : "-";
    const disabled = device.instances.length === 0;
    const migrationDisabledReason = !migrationAvailable ? "pairing" : disabled ? "unassigned" : "";
    const migrationDisabledAttr = migrationDisabledReason
      ? `disabled data-disabled-reason=\"${migrationDisabledReason}\"`
      : "";
    const draft = installDrafts.has(device.ieee) ? installDrafts.get(device.ieee) : device.installCode || "";
    const hasInstall = draft.trim().length > 0;
    const installLabel = hasInstall ? "Edit" : "+";
    const installClass = hasInstall ? "has-code" : "empty";
    const isOpen = openInstallEditors.has(device.ieee);

    const currentName = device.currentName || "-";
    const mismatch = device.nameMismatch;
    const lastSeen = formatLastSeen(device.lastSeen);
    const lastSeenHtml = lastSeen
      ? `<div class="last-seen" title="Last seen">${lastSeen}</div>`
      : "";
    const migrationStatus = device.migrationStatus
      ? `<div class="migration-status">${device.migrationStatus}</div>`
      : "";
    rows.push(`
      <div class="row data ${mismatch ? "mismatch" : ""}" data-ieee="${device.ieee}">
        <div class="name-cell">
          ${
            mismatch
              ? `<div class="name-current">Current name: <span>${currentName}</span></div>
          <button class="rename-button" data-action="rename-to" data-help="Rename the device in this instance to match the stored mapping.">Change to</button>`
              : ""
          }
          <div class="name-edit">
            <input type="text" value="${device.mappedName}" data-field="name" data-original="${device.mappedName}" />
            <button class="ghost save-button hidden" data-action="save" data-help="Save the mapping name for this device.">Save</button>
            ${
              mismatch
                ? `<button class="ghost tiny-button" data-action="mapping-current" data-help="Update the stored mapping to the current device name.">Use current name</button>`
                : ""
            }
          </div>
          ${migrationStatus}
        </div>
        <div class="mono">${device.ieee}</div>
        <div class="install-cell">
          <button class="ghost install-toggle ${installClass}" data-action="install-edit" data-help="Edit or add the install code for this device.">${installLabel}</button>
          <div class="install-editor ${isOpen ? "" : "hidden"}">
            <input type="text" value="${draft}" data-field="install-code" data-original="${draft}" />
            <button class="ghost scan-button" data-action="install-scan"${
              scanAvailable ? "" : " disabled"
            } aria-label="Scan QR code" data-help="Scan a QR code into the install code field.">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="2.5" y="2.5" width="7" height="7" rx="1.2"></rect>
                <rect x="14.5" y="2.5" width="7" height="7" rx="1.2"></rect>
                <rect x="2.5" y="14.5" width="7" height="7" rx="1.2"></rect>
                <rect x="10.2" y="10.2" width="3.6" height="3.6" rx="0.6"></rect>
                <rect x="14.5" y="14.5" width="7" height="7" rx="1.2"></rect>
                <path d="M7.2 18.8h5.4"></path>
                <path d="M18.8 7.2v5.4"></path>
              </svg>
            </button>
            ${
              hasInstall
                ? `<select data-action="install-apply">
              <option value="" selected disabled>Add to...</option>
              ${backendOptions}
            </select>`
                : ""
            }
          </div>
        </div>
        <div class="${hasInstances ? "" : "unassigned"}">${instances}</div>
        <div>
          ${
            device.type === "Router"
              ? `<svg class="type-icon router" viewBox="0 0 24 24" aria-hidden="true" title="Router">
                  <path d="M4 14c3-3 13-3 16 0"></path>
                  <path d="M7 17c2-2 8-2 10 0"></path>
                  <path d="M11 20h2"></path>
                  <circle cx="12" cy="11" r="1.4"></circle>
                  <path d="M12 9V4"></path>
                </svg>`
              : '<span class="type-icon end" title="End device"></span>'
          }
        </div>
        <div>${
          device.supported && device.model && device.vendor
            ? `<a class="model-link" href="https://www.zigbee2mqtt.io/devices/${encodeURIComponent(
                normalizeModel(device.model),
              )}.html#${encodeURIComponent(
                normalizeModel(`${device.vendor.toLowerCase()}-${device.model.toLowerCase()}`),
              )}" target="_blank" rel="noreferrer">${device.model}</a>`
            : device.modelId
              ? `<a class="model-link" href="https://www.zigbee2mqtt.io/advanced/support-new-devices/01_support_new_devices.html" target="_blank" rel="noreferrer">${device.modelId}</a>`
              : "-"
        }</div>
        <div>${lqi}</div>
        <div>
          <span class="badge ${effectiveClass}">${effectiveLabel}</span>
          ${lastSeenHtml}
        </div>
        <div class="actions">
          <button data-action="migrate" ${migrationDisabledAttr} data-help="Remove the device from its current instance to start migration.">Migrate</button>
          <button class="force-migrate" data-action="force-migrate" ${migrationDisabledAttr} data-help="Force migration and remove blocklist after interview if needed.">Force migration</button>
          <button class="ghost" data-action="ha-details" data-help="Open the HA IDs panel to save a snapshot, restore entity_id, and scan/rewrite device_id/registry_id in automations, scripts, and scenes.">HA IDs</button>
          ${
            device.online === false
              ? '<button class="ghost danger" data-action="delete-offline" data-help="Remove this offline device from local mappings.">Delete</button>'
              : ""
          }
        </div>
      </div>
    `);
  });

  elements.deviceTable.innerHTML = rows.join("");
  document.querySelectorAll(".sort").forEach((node) => {
    node.classList.toggle("active", node.dataset.sort === sortKey);
  });
};

const renderCoordinators = (coordinators = []) => {
  if (!elements.coordinatorTable) {
    return;
  }
  if (!coordinators || coordinators.length === 0) {
    elements.coordinatorTable.innerHTML = "<p class=\"subtitle\">No coordinator data yet.</p>";
    return;
  }
  const hasStatus = coordinators.some((entry) => entry.changed);
  const rows = [
    `<div class="row header">
      <div>Instance</div>
      <div>Type</div>
      <div>IEEE address</div>
      <div>Revision</div>
      <div>Serial</div>
      ${hasStatus ? "<div>Status</div>" : ""}
    </div>`,
  ];
  coordinators.forEach((entry) => {
    const serial = [entry.adapter, entry.serialPort].filter(Boolean).join(" · ");
    const status = entry.changed ? "Changed" : "";
    const rowClass = entry.changed ? "coordinator-row changed" : "coordinator-row";
    rows.push(`
      <div class="row data ${rowClass}" data-backend="${entry.id}">
        <div>${entry.label || entry.id}</div>
        <div>${entry.type || "-"}</div>
        <div class="mono">${entry.ieee || "-"}</div>
        <div>${entry.revision || "-"}</div>
        <div class="mono">${serial || "-"}</div>
        ${hasStatus ? `<div class="mono">${status}</div>` : ""}
      </div>
    `);
  });
  elements.coordinatorTable.innerHTML = rows.join("");
};
const filterLogs = (logs) => {
  const query = elements.deviceSearch.value.trim().toLowerCase();
  if (!query || !lastState || !lastState.devices) {
    return logs;
  }
  const matched = lastState.devices.filter(
    (device) =>
      device.mappedName.toLowerCase().includes(query) || device.ieee.toLowerCase().includes(query),
  );
  if (matched.length === 0) {
    return [];
  }
  const names = matched.map((device) => device.mappedName.toLowerCase()).filter(Boolean);
  const ieee = matched.map((device) => device.ieee.toLowerCase()).filter(Boolean);
  return logs.filter((entry) => {
    const message = (entry.message || "").toLowerCase();
    return names.some((name) => message.includes(name)) || ieee.some((id) => message.includes(id));
  });
};

const renderLogs = (logs) => {
  const filtered = filterLogs(logs || []);
  if (!filtered || filtered.length === 0) {
    elements.activityLog.innerHTML = "<p class=\"subtitle\">No activity yet.</p>";
    return;
  }
  elements.activityLog.innerHTML = filtered
    .map((entry) => {
      const stamp = new Date(entry.time);
      const today = new Date();
      const sameDay =
        stamp.getFullYear() === today.getFullYear() &&
        stamp.getMonth() === today.getMonth() &&
        stamp.getDate() === today.getDate();
      const time = sameDay
        ? stamp.toLocaleTimeString(undefined)
        : stamp.toLocaleString(undefined);
      const typeClass = entry.type ? ` ${entry.type}` : "";
      return `
        <div class="activity-item${typeClass}">
          <div class="message">${entry.message}</div>
          <div class="time">${time}</div>
        </div>
      `;
      })
      .join("");
};

const formatIdentifiers = (items) => {
  if (!items || items.length === 0) {
    return "-";
  }
  return items
    .map((entry) => (Array.isArray(entry) ? `${entry[0]}:${entry[1]}` : String(entry)))
    .join(", ");
};

const buildHaConfigUrl = (type, configId) => {
  if (!haBaseUrl || !configId) {
    return "";
  }
  const cleanId = configId.includes(".") ? configId.split(".").slice(1).join(".") : configId;
  const base = haBaseUrl.replace(/\/$/, "");
  if (type === "script") {
    return `${base}/config/script/edit/${encodeURIComponent(cleanId)}`;
  }
  if (type === "scene") {
    return `${base}/config/scene/edit/${encodeURIComponent(cleanId)}`;
  }
  return `${base}/config/automation/edit/${encodeURIComponent(cleanId)}`;
};

const buildHaDeviceUrl = (deviceId) => {
  if (!haBaseUrl || !deviceId) {
    return "";
  }
  return `${haBaseUrl.replace(/\/$/, "")}/config/devices/device/${encodeURIComponent(deviceId)}`;
};

const renderHaInfo = (payload) => {
  const info = payload?.info;
  if (payload?.haUrl) {
    haBaseUrl = payload.haUrl;
  }
  if (!info) {
    elements.haStatus.textContent = payload?.error || "No Home Assistant data.";
    elements.haSnapshotInfo.textContent = "-";
    elements.haDeviceInfo.textContent = "-";
    elements.haEntityInfo.innerHTML = "";
    elements.haAutomationInfo.textContent = "-";
    elements.haAutomationList.innerHTML = "";
    elements.haSnapshot.disabled = true;
    elements.haRestore.disabled = true;
    elements.haAutomationPreview.disabled = true;
    elements.haAutomationApply.disabled = true;
    return;
  }

  const snapshot = info.snapshot;
  const current = info.currentDevice;
  const statusLines = [];
  if (snapshot && snapshot.device) {
    statusLines.push(
      `Snapshot: ${snapshot.updatedAt || "unknown time"} (${snapshot.entities?.length || 0} entities)`,
    );
  } else {
    statusLines.push("Snapshot: not saved");
  }
  if (current) {
    statusLines.push(`Current device: ${current.id}`);
  } else {
    statusLines.push("Current device: not found in Home Assistant");
  }
  elements.haStatus.textContent = statusLines.join("\n");

  if (snapshot && snapshot.device) {
    const snapshotLines = [
      `Device ID: ${snapshot.device.id || "-"}`,
      `Name: ${snapshot.device.name || "-"}`,
      `Identifiers: ${formatIdentifiers(snapshot.device.identifiers)}`,
    ];
    elements.haSnapshotInfo.textContent = snapshotLines.join("\n");
    elements.haRestore.disabled = false;
  } else {
    elements.haSnapshotInfo.textContent = "No snapshot saved yet.";
    elements.haRestore.disabled = true;
  }

  if (current) {
    const deviceUrl = buildHaDeviceUrl(current.id);
    const deviceLines = [
      `Device ID: ${current.id || "-"}`,
      `Name: ${current.name || "-"}`,
      `Manufacturer: ${current.manufacturer || "-"}`,
      `Model: ${current.model || "-"}`,
      `Identifiers: ${formatIdentifiers(current.identifiers)}`,
    ];
    const link = deviceUrl
      ? `<br><a class="ha-link" href="${deviceUrl}" target="_blank" rel="noreferrer">Open device</a>`
      : "";
    elements.haDeviceInfo.innerHTML = `${deviceLines.join("<br>")}${link}`;
  } else {
    elements.haDeviceInfo.textContent = "Device not found in Home Assistant.";
  }

  const plan = info.restorePlan || [];
  const currentEntities = info.currentEntities || [];
  if (plan.length === 0 && currentEntities.length === 0) {
    elements.haEntityInfo.innerHTML = "<div class=\"subtitle\">No entity data available.</div>";
  } else {
    const rows = [
      `<div class="ha-row header">
        <div>Status</div>
        <div>Saved entity_id</div>
        <div>Current entity_id</div>
        <div>Saved reg_id</div>
        <div>Current reg_id</div>
      </div>`,
    ];
    if (plan.length > 0) {
      plan.forEach((item) => {
        const status = item.status || "missing";
        const detail =
          status === "warn"
            ? `<div class="ha-detail">Warn: entity_id matches, but registry_id changed. Automations may still reference the old registry id.</div>`
            : "";
        rows.push(`
          <div class="ha-row" data-expand="false">
            <div class="ha-status ${status}">${status}</div>
            <div class="mono">${item.desired_entity_id || "-"}</div>
            <div class="mono">${item.current_entity_id || "-"}</div>
            <div class="mono">${item.desired_registry_id || "-"}</div>
            <div class="mono">${item.current_registry_id || "-"}</div>
            ${detail}
          </div>
        `);
      });
    } else {
      currentEntities.forEach((item) => {
        rows.push(`
          <div class="ha-row" data-expand="false">
            <div class="ha-status ok">current</div>
            <div class="mono">-</div>
            <div class="mono">${item.entity_id || "-"}</div>
            <div class="mono">-</div>
            <div class="mono">${item.entity_registry_id || "-"}</div>
          </div>
        `);
      });
    }
    elements.haEntityInfo.innerHTML = rows.join("");
  }

  if (haAutomationPreview) {
    const lines = [
      `Automations: ${haAutomationPreview.automations}`,
      `Scripts: ${haAutomationPreview.scripts || 0}`,
      `Scenes: ${haAutomationPreview.scenes || 0}`,
      `Affected: ${haAutomationPreview.affectedAutomations}`,
      `Replacements: ${haAutomationPreview.replacementHits}`,
    ];
    if (typeof haAutomationPreview.deviceHits === "number") {
      lines.push(`Device ID replacements: ${haAutomationPreview.deviceHits}`);
    }
    if (typeof haAutomationPreview.entityHits === "number") {
      lines.push(`Entity ID replacements: ${haAutomationPreview.entityHits}`);
    }
    const mappings = haAutomationPreview.deviceIdMap || [];
    if (mappings.length > 0) {
      lines.push("Device ID map:");
      mappings.slice(0, 5).forEach((entry) => {
        lines.push(`- ${entry.ieee}: ${entry.from} -> ${entry.to}`);
      });
      if (mappings.length > 5) {
        lines.push(`- and ${mappings.length - 5} more...`);
      }
    }
    elements.haAutomationInfo.textContent = lines.join("\n");
    const affected = haAutomationPreview.affected || [];
    if (affected.length > 0) {
      elements.haAutomationList.innerHTML = affected
        .slice(0, 10)
        .map((entry) => {
          const url = buildHaConfigUrl(entry.type, entry.id);
          const label = entry.alias || entry.id || "automation";
          const prefix = entry.type ? `${entry.type}: ` : "";
          const ieees = entry.ieees && entry.ieees.length > 0 ? entry.ieees.join(", ") : "";
          const detail = [];
          if (typeof entry.deviceHits === "number" && entry.deviceHits > 0) {
            detail.push(`device_id: ${entry.deviceHits}`);
          }
          if (typeof entry.entityHits === "number" && entry.entityHits > 0) {
            detail.push(`entity_id: ${entry.entityHits}`);
          }
          const note = detail.length > 0 ? `Changes: ${detail.join(", ")}` : "Changes detected";
          const deviceNote = ieees ? `Device(s): ${ieees}` : "Device: unknown";
          const meta = `<span class="ha-meta">${deviceNote} · ${note}</span>`;
          if (!url) {
            return `<div class="ha-item"><span class="ha-more">${prefix}${label}</span>${meta}</div>`;
          }
          return `<div class="ha-item"><a class="ha-link" href="${url}" target="_blank" rel="noreferrer">${prefix}${label}</a>${meta}</div>`;
        })
        .join("");
      if (affected.length > 10) {
        elements.haAutomationList.innerHTML += `<span class="ha-more">+${affected.length - 10} more...</span>`;
      }
    } else {
      elements.haAutomationList.innerHTML = "";
    }
  } else {
    elements.haAutomationInfo.textContent = "No scan run yet.";
    elements.haAutomationList.innerHTML = "";
  }

  elements.haAutomationApply.disabled = !haAutomationPreview || haAutomationPreview.affectedAutomations === 0;
  elements.haSnapshot.disabled = false;
  elements.haAutomationPreview.disabled = false;
};

const openHaModal = async (ieee, label) => {
  haModalIeee = ieee;
  haAutomationPreview = null;
  elements.haDeviceTitle.textContent = label ? `${label} (${ieee})` : ieee;
  elements.haStatus.textContent = "Loading...";
  elements.haSnapshotInfo.textContent = "-";
  elements.haDeviceInfo.textContent = "-";
  elements.haEntityInfo.innerHTML = "";
  elements.haAutomationInfo.textContent = "No scan run yet.";
  elements.haAutomationList.innerHTML = "";
  elements.haSnapshot.disabled = true;
  elements.haRestore.disabled = true;
  elements.haAutomationPreview.disabled = true;
  elements.haAutomationApply.disabled = true;
  elements.haModal.classList.remove("hidden");
  try {
    const result = await getJson(`api/ha/device?ieee=${encodeURIComponent(ieee)}`);
    lastHaInfo = result.info || null;
    if (result.haUrl) {
      haBaseUrl = result.haUrl;
    }
    renderHaInfo(result);
    elements.haEntityInfo.querySelectorAll(".ha-row").forEach((row) => {
      row.addEventListener("click", () => {
        row.classList.toggle("expanded");
      });
    });
  } catch (error) {
    lastHaInfo = null;
    renderHaInfo({ error: "Failed to load Home Assistant data." });
  }
};

const renderInstanceFilters = (backends) => {
  if (!backends || backends.length === 0) {
    elements.instanceFilters.innerHTML = "";
    return;
  }
  if (selectedInstances.size === 0) {
    backends.forEach((backend) => selectedInstances.add(backend.label));
    saveFilters();
  }
  elements.instanceFilters.innerHTML = backends
    .map(
      (backend) => `
        <label>
          <input type="checkbox" data-instance="${backend.label}" ${
            selectedInstances.has(backend.label) ? "checked" : ""
          } />
          ${backend.label}
        </label>
      `,
    )
    .join("");
};

const loadState = async () => {
  try {
    if (isEditing) {
      return;
    }
    const response = await fetch(stateUrl);
    const data = await response.json();
    lastState = data;
    renderOverview(data.overview || {});
    renderPairing(data.pairing || []);
    renderPairingControl(data.pairing || [], data.backends || []);
    renderInstanceFilters(data.backends || []);
    renderTable(data.devices || [], data.migrationAvailable, data.backends || []);
    renderCoordinators(data.coordinators || []);
    elements.mappingCount.textContent = `${data.mappingsCount || 0} mappings`;
  } catch (error) {
    showToast("Failed to load state");
  }
};

const loadLogs = async () => {
  try {
    if (isEditing) {
      return;
    }
    const response = await fetch(logsUrl);
    const data = await response.json();
    lastLogs = data.logs || [];
    renderLogs(lastLogs);
  } catch (error) {
    showToast("Failed to load logs");
  }
};

const getJson = async (url) => {
  const response = await fetch(url);
  return response.json();
};

const postJson = async (url, payload) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return response.json();
};

const postEmpty = async (url) => {
  const response = await fetch(url, { method: "POST" });
  return response.json();
};

const showScanner = async (input) => {
  if (!scanAvailable) {
    showToast("Scanner not available");
    return;
  }
  scannerTarget = input;
  const row = input.closest(".row.data");
  scannerTargetIeee = row ? row.dataset.ieee : null;
  elements.qrScanner.classList.remove("hidden");
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    elements.qrVideo.srcObject = scannerStream;
    await elements.qrVideo.play();
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const scan = async () => {
      if (!scannerStream) {
        return;
      }
      const results = await detector.detect(elements.qrVideo);
      if (results && results.length > 0) {
        const value = results[0].rawValue || "";
        if (value) {
          if (scannerTargetIeee) {
            installDrafts.set(scannerTargetIeee, value);
            openInstallEditors.add(scannerTargetIeee);
          }
          renderTable(lastState?.devices || [], lastState?.migrationAvailable, lastState?.backends || []);
          let target = scannerTarget;
          if (!target && scannerTargetIeee) {
            const activeRow = document.querySelector(`.row.data[data-ieee="${scannerTargetIeee}"]`);
            if (activeRow) {
              target = activeRow.querySelector("input[data-field=\"install-code\"]");
            }
          }
          if (target) {
            target.value = value;
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("blur", { bubbles: true }));
          }
          if (scannerTargetIeee) {
            postJson("api/install-codes", { ieee: scannerTargetIeee, code: value })
              .then((result) => {
                if (result && result.error) {
                  showToast(result.error);
                  return;
                }
                installDrafts.delete(scannerTargetIeee);
                showToast("Install code saved");
              })
              .catch(() => {
                showToast("Failed to save install code");
              });
          }
          const trimmed = value.length > 20 ? `${value.slice(0, 20)}…` : value;
          showToast(`Read code: ${trimmed}`);
          closeScanner();
          return;
        }
      }
      requestAnimationFrame(scan);
    };
    requestAnimationFrame(scan);
  } catch (error) {
    console.error("Scanner error", error);
    showToast("Unable to start scanner");
    closeScanner();
  }
};

const closeScanner = () => {
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }
  elements.qrVideo.srcObject = null;
  elements.qrScanner.classList.add("hidden");
  scannerTarget = null;
  scannerTargetIeee = null;
};

const handleAction = async (action, row, button) => {
  const ieee = row.dataset.ieee;
  const disabledReason = button?.dataset.disabledReason || "";
  if (action === "migrate" || action === "force-migrate") {
    flashButton(button);
    if (disabledReason) {
      if (disabledReason === "pairing") {
        showToast("Migration needs pairing enabled on the target instance.");
        return;
      }
      if (disabledReason === "unassigned") {
        showToast("Migration unavailable: device is not assigned to any instance.");
        return;
      }
    }
  }
  const nameInput = row.querySelector("input[data-field=\"name\"]");

  if (action === "save") {
    const name = nameInput.value.trim();
    if (!name) {
      showToast("Name is required");
      return;
    }
    const result = await postJson("api/mappings", { ieee, name });
    if (result.error) {
      showToast(result.error);
      return;
    }
    showToast("Mapping saved");
    loadState();
    return;
  }

  if (action === "install-edit") {
    const editor = row.querySelector(".install-editor");
    if (editor) {
      editor.classList.toggle("hidden");
      if (editor.classList.contains("hidden")) {
        openInstallEditors.delete(ieee);
      } else {
        openInstallEditors.add(ieee);
      }
      const input = editor.querySelector("input[data-field=\"install-code\"]");
      if (input) {
        input.focus();
      }
    }
    return;
  }

  if (action === "install-scan") {
    const input = row.querySelector("input[data-field=\"install-code\"]");
    if (input) {
      showScanner(input);
    }
    return;
  }

  if (action === "migrate") {
    const result = await postJson("api/migrate", { ieee });
    if (result.status === "recent") {
      showToast("Migrate clicked a moment ago");
    } else if (result.status === "blocked_pairing") {
      showToast("Stop pairing on this instance before migrating");
    } else {
      showToast(`Migrate: ${result.status || "sent"}`);
    }
    loadState();
    return;
  }

  if (action === "force-migrate") {
    const result = await postJson("api/migrate/force", { ieee });
    if (result.status === "recent") {
      showToast("Force migration clicked a moment ago");
    } else if (result.status === "blocked_pairing") {
      showToast("Stop pairing on this instance before migrating");
    } else {
      showToast(`Force migration: ${result.status || "sent"}`);
    }
    loadState();
    return;
  }

  if (action === "ha-details") {
    const nameInput = row.querySelector("input[data-field=\"name\"]");
    const label = nameInput ? nameInput.value.trim() : "";
    openHaModal(ieee, label);
    return;
  }

  if (action === "rename-to") {
    const result = await postJson("api/mappings/rename-to", { ieee });
    if (result.error) {
      showToast(result.error);
      return;
    }
    showToast("Rename command sent");
    loadState();
    return;
  }

  if (action === "mapping-current") {
    const current = row.querySelector(".name-current span")?.textContent?.trim();
    if (!current) {
      showToast("Current name not available");
      return;
    }
    const result = await postJson("api/mappings", { ieee, name: current });
    if (result.error) {
      showToast(result.error);
      return;
    }
    showToast("Mapping updated to current name");
    loadState();
    return;
  }

  if (action === "delete-offline") {
    if (!confirm("Delete this offline device from local mappings?")) {
      return;
    }
    const result = await postJson("api/mappings/delete-offline", { ieee });
    if (result.error) {
      showToast(result.error);
      return;
    }
    showToast("Offline device removed");
    loadState();
  }
};

elements.deviceTable.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    const sortButton = event.target.closest("button.sort");
    if (!sortButton) {
      return;
    }
    const nextKey = sortButton.dataset.sort;
    if (nextKey === sortKey) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = nextKey;
      sortDir = "asc";
    }
    renderTable(lastState?.devices || [], lastState?.migrationAvailable, lastState?.backends || []);
    document.querySelectorAll(".sort").forEach((node) => {
      node.classList.toggle("active", node.dataset.sort === sortKey);
    });
    return;
  }
  const row = button.closest(".row.data");
  if (!row) {
    return;
  }
  const action = button.dataset.action;
  handleAction(action, row, button);
});

elements.coordinatorTable?.addEventListener("click", async (event) => {
  const row = event.target.closest(".row.data");
  if (!row) {
    return;
  }
  row.classList.toggle("expanded");
});

elements.coordinatorSaveAll?.addEventListener("click", async () => {
  const result = await postEmpty("api/coordinators/accept-all");
  if (result.error) {
    showToast(result.error);
    return;
  }
  showToast("Coordinator snapshot saved");
  loadState();
});

elements.deviceTable.addEventListener("input", (event) => {
  const input = event.target.closest("input[data-field=\"name\"]");
  if (!input) {
    const installInput = event.target.closest("input[data-field=\"install-code\"]");
    if (installInput) {
      const row = installInput.closest(".row.data");
      if (row) {
        const ieee = row.dataset.ieee;
        installDrafts.set(ieee, installInput.value);
      }
    }
    return;
  }
  const row = input.closest(".row.data");
  if (!row) {
    return;
  }
  const original = input.dataset.original || "";
  const changed = input.value.trim() !== original;
  const saveButton = row.querySelector(".save-button");
  if (saveButton) {
    saveButton.classList.toggle("hidden", !changed);
  }
  isEditing = true;
});

elements.deviceTable.addEventListener(
  "blur",
  async (event) => {
    const installInput = event.target.closest("input[data-field=\"install-code\"]");
    if (!installInput) {
      isEditing = false;
      return;
    }
    const row = installInput.closest(".row.data");
    if (!row) {
      return;
    }
    const ieee = row.dataset.ieee;
    const code = installInput.value.trim();
    const original = installInput.dataset.original || "";
    if (code === original) {
      isEditing = false;
      return;
    }
    const result = await postJson("api/install-codes", { ieee, code });
    if (result.error) {
      showToast(result.error);
      return;
    }
    installDrafts.delete(ieee);
    installInput.dataset.original = code;
    showToast(code ? "Install code saved" : "Install code removed");
    loadState();
    isEditing = false;
  },
  true,
);

elements.deviceTable.addEventListener(
  "focusin",
  (event) => {
    const editable = event.target.closest("input[data-field=\"name\"], input[data-field=\"install-code\"]");
    if (!editable) {
      return;
    }
    isEditing = true;
  },
  true,
);

elements.deviceTable.addEventListener("change", async (event) => {
  const select = event.target.closest("select[data-action=\"install-apply\"]");
  if (!select) {
    return;
  }
  const row = select.closest(".row.data");
  if (!row) {
    return;
  }
  const ieee = row.dataset.ieee;
  const input = row.querySelector("input[data-field=\"install-code\"]");
  const code = input ? input.value.trim() : "";
  if (!code) {
    showToast("Install code is empty");
    select.value = "";
    return;
  }
  const backendId = select.value;
  const result = await postJson("api/install-codes/apply", { ieee, backendId, code });
  if (result.error) {
    showToast(result.error);
    return;
  }
  showToast("Install code applied");
  select.value = "";
});

elements.deviceSearch.addEventListener("input", () => {
  saveFilters();
  renderTable(lastState?.devices || [], lastState?.migrationAvailable, lastState?.backends || []);
  renderLogs(lastLogs);
});

elements.instanceFilters.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[type=\"checkbox\"]");
  if (!checkbox) {
    return;
  }
  const label = checkbox.dataset.instance;
  if (!label) {
    return;
  }
  if (checkbox.checked) {
    selectedInstances.add(label);
  } else {
    selectedInstances.delete(label);
  }
  saveFilters();
  renderTable(lastState?.devices || [], lastState?.migrationAvailable, lastState?.backends || []);
});

elements.qrClose.addEventListener("click", () => closeScanner());
elements.qrScanner.addEventListener("click", (event) => {
  if (event.target === elements.qrScanner) {
    closeScanner();
  }
});

elements.resetMappings.addEventListener("click", async () => {
  if (!confirm("Reset all mappings and reload from instances?")) {
    return;
  }
  const result = await postEmpty("api/reset");
  if (result.error) {
    showToast(result.error);
    return;
  }
  showToast("Mappings reset");
  loadState();
});

elements.applyMappings.addEventListener("click", async () => {
  const result = await postEmpty("api/mappings/apply");
  if (result.error) {
    showToast(result.error);
    return;
  }
  const mismatches = result.mismatches || [];
  if (mismatches.length === 0) {
    showToast("No mapping changes detected");
    return;
  }
  mappingQueue = mismatches;
  showNextMapping();
});

elements.pairingControl?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.action;
  const backendId = button.dataset.backend;
  if (!backendId) {
    return;
  }
  const enable = action === "pairing-enable" || action === "pairing-refresh";
  const result = await postJson("api/pairing", { backendId, enable });
  if (result.error) {
    showToast(result.error);
  } else {
    showToast(enable ? `Pairing enabled for ${result.label}` : `Pairing disabled for ${result.label}`);
  }
  loadState();
});

const showNextMapping = () => {
  if (mappingQueue.length === 0) {
    mappingCurrent = null;
    elements.mappingModal.classList.add("hidden");
    return;
  }
  mappingCurrent = mappingQueue.shift();
  const { current, desired, backendLabel } = mappingCurrent;
  elements.mappingModalText.textContent = `Detected device with wrong mapping (${backendLabel}). Old name: ${current}, proposed name: ${desired}.`;
  elements.mappingModal.classList.remove("hidden");
};

elements.mappingCancel.addEventListener("click", () => {
  showNextMapping();
});

elements.mappingApply.addEventListener("click", async () => {
  if (!mappingCurrent) {
    showNextMapping();
    return;
  }
  const { ieee, backendId } = mappingCurrent;
  const result = await postJson("api/mappings/apply-one", { ieee, backendId });
  if (result.error) {
    showToast(result.error);
  } else if (result.applied) {
    showToast("Mapping updated");
  }
  showNextMapping();
});

elements.haClose.addEventListener("click", () => {
  elements.haModal.classList.add("hidden");
});

elements.haModal.addEventListener("click", (event) => {
  if (event.target === elements.haModal) {
    elements.haModal.classList.add("hidden");
  }
});

elements.haSnapshot.addEventListener("click", async () => {
  if (!haModalIeee) {
    return;
  }
  const result = await postJson("api/ha/snapshot", { ieee: haModalIeee });
  if (result.error) {
    showToast(result.error);
    return;
  }
  showToast("Snapshot saved");
  openHaModal(haModalIeee);
});

elements.haRestore.addEventListener("click", async () => {
  if (!haModalIeee) {
    return;
  }
  const result = await postJson("api/ha/restore-entity-ids", { ieee: haModalIeee });
  if (result.error) {
    showToast(result.error);
    return;
  }
  showToast("Entity IDs restore requested");
  openHaModal(haModalIeee);
});

elements.haAutomationPreview.addEventListener("click", async () => {
  if (!lastHaInfo) {
    showToast("Load HA device info first");
    return;
  }
  const globalResult = await postEmpty("api/ha/automations/preview");
  if (globalResult.error) {
    showToast(globalResult.error);
    return;
  }
  haAutomationPreview = globalResult.result || null;
  if (globalResult.haUrl) {
    haBaseUrl = globalResult.haUrl;
  }
  renderHaInfo({ info: lastHaInfo });
});

elements.haAutomationApply.addEventListener("click", async () => {
  if (!haAutomationPreview) {
    showToast("Run scan first");
    return;
  }
  const result = await postEmpty("api/ha/automations/rewrite");
  if (result.error) {
    showToast(result.error);
    return;
  }
  showToast("Rewrite applied");
  haAutomationPreview = null;
  openHaModal(haModalIeee);
});

document.addEventListener("mouseover", (event) => {
  const button = event.target.closest("button");
  if (!button) {
    hideTooltip();
    return;
  }
  if (tooltipTarget === button) {
    return;
  }
  tooltipTarget = button;
  scheduleTooltip(button);
});

document.addEventListener("mouseout", (event) => {
  if (!tooltipTarget) {
    return;
  }
  if (event.relatedTarget && tooltipTarget.contains(event.relatedTarget)) {
    return;
  }
  hideTooltip();
});

document.addEventListener("focusin", (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }
  tooltipTarget = button;
  scheduleTooltip(button);
});

document.addEventListener("focusout", () => {
  hideTooltip();
});

window.addEventListener("scroll", () => {
  hideTooltip();
}, true);

window.addEventListener("resize", () => {
  hideTooltip();
});

loadFilters();
loadState();
loadLogs();
setInterval(loadState, 4000);
setInterval(loadLogs, 6000);
