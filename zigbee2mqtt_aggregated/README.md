# Zigbee2MQTT Aggregated

Aggregated Zigbee2MQTT UI that merges devices from multiple Z2M instances. It serves the zigbee2mqtt-windfront frontend and connects to the configured backends over WebSocket, prefixing device/group names with the chosen labels so search shows all instances.

## Options

- `server_one`, `server_two`, `server_three`, `server_four`: Base URLs to existing Zigbee2MQTT UIs (no trailing slash). For the official HA add-on, the default is `http://addon_45df7312_zigbee2mqtt:8099`.
- `auth_token_one`, `auth_token_two`, `auth_token_three`, `auth_token_four`: Optional tokens for each backend.
- `label_one`, `label_two`, `label_three`, `label_four`: Prefix labels shown in the UI (e.g., "One - Thermostat"). The default for the fourth instance is \"Original\".
- `networkmap_backend`: Which instance to use for the Network map. Use a label (e.g., `Two`) or backend id (`two`). Leave empty for auto (uses the last selected coordinator).

If a backend is unreachable, it is skipped and the UI still loads.

## Behavior notes

- Device and group names are prefixed in the UI (e.g., "One - Thermostat").
- Renaming a device keeps the prefix in the aggregated UI; the underlying Z2M name remains without the prefix.
- Permit join is sent to the selected coordinator and the join countdown reflects that instance.
- Network map requests use `networkmap_backend` when set; otherwise they follow the last selected coordinator.
