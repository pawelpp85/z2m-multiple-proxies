# Zigbee2MQTT Aggregated

Aggregated Zigbee2MQTT UI that merges devices from multiple Z2M instances. It serves the standard Zigbee2MQTT frontend and connects to the configured backends over WebSocket, prefixing device/group names with the chosen labels so search shows all instances.

## Options

- `server_one`, `server_two`, `server_three`: Base URLs to existing Zigbee2MQTT UIs (no trailing slash).
- `auth_token_one`, `auth_token_two`, `auth_token_three`: Optional tokens for each backend.
- `label_one`, `label_two`, `label_three`: Prefix labels shown in the UI (e.g., "One - Thermostat").

If a backend is unreachable, it is skipped and the UI still loads.
