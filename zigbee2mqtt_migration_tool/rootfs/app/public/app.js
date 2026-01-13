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
  instanceFilters: document.getElementById("instanceFilters"),
};

let lastState = null;
let toastTimeout = null;
let sortKey = "mappedName";
let sortDir = "asc";
let selectedInstances = new Set();
let lastLogs = [];

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
        case "instances":
          return item.instances ? item.instances.join(", ") : "";
        case "type":
          return item.type || "";
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
    filtered = filtered.filter((device) => device.mappedName.toLowerCase().includes(query));
  }
  if (selectedInstances.size > 0) {
    filtered = filtered.filter((device) =>
      device.instances.some((instance) => selectedInstances.has(instance)),
    );
  }
  return filtered;
};

const renderTable = (devices, migrationAvailable) => {
  const rows = [
    `<div class="row header">
      <button class="sort" data-sort="mappedName">Mapped name</button>
      <button class="sort" data-sort="ieee">IEEE address</button>
      <button class="sort" data-sort="instances">Instances</button>
      <button class="sort" data-sort="type">Type</button>
      <button class="sort" data-sort="lqi">LQI</button>
      <button class="sort" data-sort="online">Online</button>
      <div>Actions</div>
    </div>`,
  ];

  const filtered = filterDevices(devices);
  const sorted = sortDevices(filtered);

  sorted.forEach((device) => {
    const instances = device.instances && device.instances.length > 0 ? device.instances.join(", ") : "-";
    const onlineClass = device.online ? "" : "offline";
    const onlineLabel = device.online ? "Online" : "Offline";
    const lqi = typeof device.linkquality === "number" ? device.linkquality : "-";
    const disabled = device.instances.length === 0;

    rows.push(`
      <div class="row data" data-ieee="${device.ieee}">
        <div class="name-cell">
          <input type="text" value="${device.mappedName}" data-field="name" data-original="${device.mappedName}" />
          <button class="ghost save-button hidden" data-action="save">Save</button>
        </div>
        <div class="mono">${device.ieee}</div>
        <div>${instances}</div>
        <div>${device.type || "Unknown"}</div>
        <div>${lqi}</div>
        <div><span class="badge ${onlineClass}">${onlineLabel}</span></div>
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
      const time = new Date(entry.time).toLocaleString();
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
    const response = await fetch(stateUrl);
    const data = await response.json();
    lastState = data;
    renderOverview(data.overview || {});
    renderPairing(data.pairing || []);
    renderInstanceFilters(data.backends || []);
    renderTable(data.devices || [], data.migrationAvailable);
    elements.mappingCount.textContent = `${data.mappingsCount || 0} mappings`;
  } catch (error) {
    showToast("Failed to load state");
  }
};

const loadLogs = async () => {
  try {
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
    renderTable(lastState?.devices || [], lastState?.migrationAvailable);
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
});

elements.deviceSearch.addEventListener("input", () => {
  renderTable(lastState?.devices || [], lastState?.migrationAvailable);
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
  renderTable(lastState?.devices || [], lastState?.migrationAvailable);
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

loadState();
loadLogs();
setInterval(loadState, 4000);
setInterval(loadLogs, 6000);
