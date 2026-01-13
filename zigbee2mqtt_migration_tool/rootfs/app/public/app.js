const stateUrl = "api/state";
const logsUrl = "api/logs";

const elements = {
  pairingStatus: document.getElementById("pairingStatus"),
  overviewDevices: document.getElementById("overviewDevices"),
  overviewOnline: document.getElementById("overviewOnline"),
  overviewRouter: document.getElementById("overviewRouter"),
  overviewEnd: document.getElementById("overviewEnd"),
  overviewLqi: document.getElementById("overviewLqi"),
  deviceTable: document.getElementById("deviceTable"),
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
const scanAvailable =
  "BarcodeDetector" in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
const openInstallEditors = new Set();
const installDrafts = new Map();

const showToast = (message) => {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 2800);
};

const formatRemaining = (seconds) => {
  if (seconds === null || seconds === undefined) {
    return "";
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

const renderPairing = (pairing) => {
  const body = elements.pairingStatus.querySelector(".status-body");
  elements.pairingStatus.classList.remove("single", "multi");
  if (!pairing || pairing.length === 0) {
    body.textContent = "Pairing is OFF";
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
    body.innerHTML = `Pairing is on<br>${message}`;
  } else {
    elements.pairingStatus.classList.add("multi");
    body.innerHTML = `Pairing is on<br>${message}`;
  }
};

const renderOverview = (overview) => {
  elements.overviewDevices.textContent = overview.devices ?? "-";
  elements.overviewOnline.textContent = overview.online ?? "-";
  elements.overviewRouter.textContent = overview.router ?? "-";
  elements.overviewEnd.textContent = overview.endDevice ?? "-";
  elements.overviewLqi.textContent = overview.lowLqi ?? "-";
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
          return item.model || "";
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
      <button class="sort" data-sort="mappedName">Mapped name</button>
      <button class="sort" data-sort="ieee">IEEE address</button>
      <button class="sort" data-sort="installCode">Install code</button>
      <button class="sort" data-sort="instances">Instances</button>
      <button class="sort" data-sort="type">Type</button>
      <button class="sort" data-sort="model">Model</button>
      <button class="sort" data-sort="lqi">LQI</button>
      <button class="sort" data-sort="online">Online</button>
      <div>Actions</div>
    </div>`,
  ];

  const filtered = filterDevices(devices);
  const sorted = sortDevices(filtered);

  const backendOptions = backends
    .map((backend) => `<option value="${backend.id}">${backend.label}</option>`)
    .join("");

  sorted.forEach((device) => {
    const hasInstances = device.instances && device.instances.length > 0;
    const instances = hasInstances ? device.instances.join(", ") : "Unassigned";
    const effectiveOnline = hasInstances ? device.online : false;
    const effectiveLabel = effectiveOnline ? "Online" : "Offline";
    const effectiveClass = effectiveOnline ? "" : "offline";
    const lqi = typeof device.linkquality === "number" ? device.linkquality : "-";
    const disabled = device.instances.length === 0;
    const draft = installDrafts.has(device.ieee) ? installDrafts.get(device.ieee) : device.installCode || "";
    const hasInstall = draft.trim().length > 0;
    const installLabel = hasInstall ? "Edit" : "+";
    const installClass = hasInstall ? "has-code" : "empty";
    const isOpen = openInstallEditors.has(device.ieee);

    rows.push(`
      <div class="row data" data-ieee="${device.ieee}">
        <div class="name-cell">
          <input type="text" value="${device.mappedName}" data-field="name" data-original="${device.mappedName}" />
          <button class="ghost save-button hidden" data-action="save">Save</button>
        </div>
        <div class="mono">${device.ieee}</div>
        <div class="install-cell">
          <button class="ghost install-toggle ${installClass}" data-action="install-edit">${installLabel}</button>
          <div class="install-editor ${isOpen ? "" : "hidden"}">
            <input type="text" value="${draft}" data-field="install-code" data-original="${draft}" />
            <button class="ghost scan-button" data-action="install-scan"${
              scanAvailable ? "" : " disabled"
            } aria-label="Scan QR code">
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
          device.model
            ? `<a class="model-link" href="https://www.zigbee2mqtt.io/devices/${encodeURIComponent(
                device.model,
              )}.html" target="_blank" rel="noreferrer">${device.model}</a>`
            : "-"
        }</div>
        <div>${lqi}</div>
        <div><span class="badge ${effectiveClass}">${effectiveLabel}</span></div>
        <div class="actions">
          <button data-action="migrate" ${migrationAvailable && !disabled ? "" : "disabled"}>Migrate</button>
        </div>
      </div>
    `);
  });

  elements.deviceTable.innerHTML = rows.join("");
  document.querySelectorAll(".sort").forEach((node) => {
    node.classList.toggle("active", node.dataset.sort === sortKey);
  });
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

const renderInstanceFilters = (backends) => {
  if (!backends || backends.length === 0) {
    elements.instanceFilters.innerHTML = "";
    return;
  }
  if (selectedInstances.size === 0) {
    backends.forEach((backend) => selectedInstances.add(backend.label));
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
    renderInstanceFilters(data.backends || []);
    renderTable(data.devices || [], data.migrationAvailable, data.backends || []);
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

const handleAction = async (action, row) => {
  const ieee = row.dataset.ieee;
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
    showToast(`Migrate: ${result.status}`);
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
  handleAction(action, row);
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

loadState();
loadLogs();
setInterval(loadState, 4000);
setInterval(loadLogs, 6000);
