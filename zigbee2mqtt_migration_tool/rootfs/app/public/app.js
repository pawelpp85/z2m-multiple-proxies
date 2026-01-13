const stateUrl = "/api/state";
const logsUrl = "/api/logs";

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
};

let lastState = null;
let toastTimeout = null;

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
    return "unknown";
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

const renderPairing = (pairing) => {
  const body = elements.pairingStatus.querySelector(".status-body");
  if (!pairing || pairing.length === 0) {
    body.textContent = "Pairing is OFF on all instances";
    return;
  }
  const message = pairing
    .map((entry) => `${entry.label} (${formatRemaining(entry.remaining)})`)
    .join(", ");
  body.textContent = `Pairing enabled on: ${message}`;
};

const renderOverview = (overview) => {
  elements.overviewDevices.textContent = overview.devices ?? "-";
  elements.overviewOnline.textContent = overview.online ?? "-";
  elements.overviewRouter.textContent = overview.router ?? "-";
  elements.overviewEnd.textContent = overview.endDevice ?? "-";
  elements.overviewLqi.textContent = overview.lowLqi ?? "-";
};

const renderTable = (devices, migrationAvailable) => {
  const rows = [
    `<div class="row header">
      <div>IEEE address</div>
      <div>Mapped name</div>
      <div>Instances</div>
      <div>Type</div>
      <div>LQI</div>
      <div>Online</div>
      <div>Actions</div>
    </div>`,
  ];

  devices.forEach((device) => {
    const instances = device.instances && device.instances.length > 0 ? device.instances.join(", ") : "-";
    const onlineClass = device.online ? "" : "offline";
    const onlineLabel = device.online ? "Online" : "Offline";
    const lqi = typeof device.linkquality === "number" ? device.linkquality : "-";
    const disabled = device.instances.length === 0;

    rows.push(`
      <div class="row data" data-ieee="${device.ieee}">
        <div class="mono">${device.ieee}</div>
        <div>
          <input type="text" value="${device.mappedName}" data-field="name" />
        </div>
        <div>${instances}</div>
        <div>${device.type || "Unknown"}</div>
        <div>${lqi}</div>
        <div><span class="badge ${onlineClass}">${onlineLabel}</span></div>
        <div class="actions">
          <button data-action="save">Save</button>
          <button class="secondary" data-action="delete">Delete mapping</button>
          <button class="ghost" data-action="remove" ${disabled ? "disabled" : ""}>Remove</button>
          <button data-action="migrate" ${migrationAvailable && !disabled ? "" : "disabled"}>Migrate</button>
        </div>
      </div>
    `);
  });

  elements.deviceTable.innerHTML = rows.join("");
};

const renderLogs = (logs) => {
  if (!logs || logs.length === 0) {
    elements.activityLog.innerHTML = "<p class=\"subtitle\">No activity yet.</p>";
    return;
  }
  elements.activityLog.innerHTML = logs
    .map(
      (entry) => `
        <div class="activity-item">
          <div class="time">${entry.time}</div>
          <div>${entry.message}</div>
        </div>
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
    renderLogs(data.logs || []);
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

const deleteJson = async (url) => {
  const response = await fetch(url, { method: "DELETE" });
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
    const result = await postJson("/api/mappings", { ieee, name });
    if (result.error) {
      showToast(result.error);
      return;
    }
    showToast("Mapping saved");
    loadState();
    return;
  }

  if (action === "delete") {
    if (!confirm("Delete mapping entry?")) {
      return;
    }
    const result = await deleteJson(`/api/mappings/${ieee}`);
    if (result.error) {
      showToast(result.error);
      return;
    }
    showToast("Mapping deleted");
    loadState();
    return;
  }

  if (action === "remove") {
    const result = await postJson("/api/remove", { ieee });
    showToast(`Remove: ${result.status}`);
    loadState();
    return;
  }

  if (action === "migrate") {
    const result = await postJson("/api/migrate", { ieee });
    showToast(`Migrate: ${result.status}`);
    loadState();
  }
};

elements.deviceTable.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  const row = button.closest(".row.data");
  if (!row) {
    return;
  }
  const action = button.dataset.action;
  handleAction(action, row);
});

loadState();
loadLogs();
setInterval(loadState, 4000);
setInterval(loadLogs, 6000);
