# Zigbee2MQTT Migration tool

Migration tool for moving devices between Zigbee2MQTT instances. Besides helping remove/add devices, it checks where Home Assistant uses their device IDs and entity IDs and repairs migration-related issues.

## How to use
This tool helps migrate devices between Zigbee2MQTT instances, but it is not fully automatic.

Configure the add-on with URLs for all your instances. The tool discovers devices, IEEE addresses, and names, and stores the mapping for future moves. Use the mapped name here instead of renaming directly in Zigbee2MQTT.

Before migrating, make sure an install code is stored for the device. Install codes are saved per IEEE address and can be scanned with the camera and added to the target instance.

1. If mappings are not imported automatically, click Reset mappings.
2. Click one of the Zigbee2MQTT instances to start pairing.
3. In Device mappings, pick the device you want to move.
4. Click Migrate or Force migration.
5. If the device requires pairing mode (e.g., press a button), do it. Many devices do not require this even if they have a reset button; after leaving the old instance they will initiate joining the new one.
6. Wait a few seconds for the device to join the new network. The tool renames it automatically.
7. Click HA IDs to check whether entity_id changes are needed (usually not).
8. Click Scan in the HA IDs panel to check whether IDs in automations need rewriting.

Pairing buttons in the UI can enable/disable pairing and extend pairing for another 4 minutes.

Reset mappings reloads current names from all instances and removes mappings for devices not present in any instance.
Apply mappings checks for mismatched names and lets you confirm renames per instance.
If the current name is the desired one, update the mapping to the current name instead.

## Home Assistant IDs (HA IDs)
The HA IDs panel snapshots and restores Home Assistant identifiers and can repair automations that reference stale IDs.

### Concepts
- **Device ID**: Internal Home Assistant device registry ID (32‑char hex). Can change after migration.
- **Entity ID**: Human‑readable entity id (`climate.living_room_thermostat`). Can be renamed and restored.
- **Entity registry ID**: Internal entity registry ID (32‑char hex) used by device triggers/actions.
- **Unique ID**: Integration unique id (from Z2M). Cannot be edited in HA; used to match entities.

### What HA IDs shows
- **Status**: snapshot timestamp + whether the device was found in HA.
- **Snapshot**: saved device ID + identifiers captured before migration.
- **Current device**: live device ID + identifiers (with link to the HA device page).
- **Entities**: saved vs current entity_id plus saved vs current entity registry IDs with status.
- **Automations**: preview of which automations, scripts, and scenes will be updated, what will be replaced, and which devices are affected.

### HA IDs buttons
- **Save snapshot**: saves HA device + entity IDs and entity registry IDs (required before migration).
- **Restore entity IDs**: renames human‑readable `entity_id` values back to snapshot values (does not change device_id or registry IDs).
- **Scan**: scans automations, scripts, and scenes and shows planned device_id/entity registry ID replacements.
- **Rewrite device IDs**: applies device_id/entity registry ID replacements to all affected automations, scripts, and scenes.

## Features
- Persistent IEEE -> name mapping stored in `/data/ieee-map.json`
- Install codes stored in `/data/install-codes.json` with apply-to-instance action
- Aggregated device list with online/availability, linkquality, and instance membership
- Recent activity with highlighted join/leave/rename events
- Pairing status banner with remaining time and warning for multiple instances
- Migration button to remove devices from an instance during pairing
- Force migration flow with blocklist handling and auto-rename
- Apply mappings workflow with confirmation dialog for mismatches
- Home Assistant snapshot + entity_id restore workflow (optional, via HA WebSocket API)
- Optional device_id/entity registry ID rewrite preview/apply for automations, scripts, and scenes

## UI
- Device mappings table with sorting, search (name + IEEE), and instance filters
- Pairing buttons per instance when disabled, with disable/extend controls when active
- Install code editor with QR scan (when supported by the browser)
- Unassigned devices are kept visible and marked offline
- HA IDs modal with snapshot status, entity_id plan, and automation rewrite preview

## Configuration
Use the same instance URLs and optional tokens as the aggregated UI add-on:
- `server_one..server_four` (optional; omit any unused instances)
- `auth_token_one..auth_token_four`
- `label_one..label_four` (optional; instances without a label are hidden)
- If `server_one` is set, `label_one` must also be set.
Optional Home Assistant integration:
- `homeassistant_url` (e.g. `http://homeassistant.local:8123`)
- `homeassistant_token` (Long-lived access token)

## Notes
- Install code “Add to…” sends `bridge/request/install_code/add` to the selected instance.
- QR scanning requires `BarcodeDetector` support in the browser.
- If Home Assistant integration is configured, clicking **Migrate**/**Force migration** captures a pre‑migration snapshot and will not proceed without it.

## Development workflow
After any change, bump the next beta version (e.g. `1.0.1b2`), commit, and run `git push`.
