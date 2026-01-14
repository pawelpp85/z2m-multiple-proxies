# Zigbee2MQTT Migration tool

Migration helper for multiple Zigbee2MQTT instances. Stores IEEE -> name mappings, keeps device names across networks, and assists during migration/pairing.

## How to use
This tool helps migrate devices between Zigbee2MQTT instances, but it is not fully automatic.

Configure the add-on with URLs for all your instances. The tool discovers devices, IEEE addresses, and names, and stores the mapping for future moves. Use the mapped name here instead of renaming directly in Zigbee2MQTT.

Before migrating, make sure an install code is stored for the device. Install codes are saved per IEEE address and can be scanned with the camera and added to the target instance.

1. Enable pairing in exactly one Zigbee2MQTT instance (do this in that instance, not here).
2. Click “Migrate” for the device to remove it from its current instance.
3. Put the device into pairing mode and follow the manufacturer or Zigbee2MQTT instructions.
4. After the device joins the new instance and finishes the interview, the mapped name is applied automatically.

Reset mappings reloads current names from all instances and removes mappings for devices not present in any instance.
Apply mappings checks for mismatched names and lets you confirm proposed changes.

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
- **Automations**: preview of which automations will be updated, what will be replaced, and which devices are affected.

### HA IDs buttons
- **Save snapshot**: saves HA device + entity IDs and entity registry IDs (required before migration).
- **Restore entity IDs**: renames human‑readable `entity_id` values back to snapshot values (does not change device_id or registry IDs).
- **Preview device_id rewrite**: scans all automations and shows planned device_id/entity_id replacements for every device with a snapshot.
- **Rewrite device IDs**: applies device_id/entity registry ID replacements to all affected automations.
- **Fix automations for this device**: applies replacements only for the currently opened device and shows how many changes will be made.

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
- Optional automation device_id rewrite preview/apply (manual action)

## UI
- Device mappings table with sorting, search (name + IEEE), and instance filters
- Pairing control dropdown when no instance is in pairing mode (disable button when active)
- Install code editor with QR scan (when supported by the browser)
- Unassigned devices are kept visible and marked offline
- HA IDs modal with snapshot status, entity_id plan, and automation rewrite preview

## Configuration
Use the same instance URLs and optional tokens as the aggregated UI add-on:
- `server_one..server_four` (optional; omit any unused instances)
- `auth_token_one..auth_token_four`
- `label_one..label_four` (optional; instances without a label are hidden)
Optional Home Assistant integration:
- `homeassistant_url` (e.g. `http://homeassistant.local:8123`)
- `homeassistant_token` (Long-lived access token)

## Notes
- Install code “Add to…” sends `bridge/request/install_code/add` to the selected instance.
- QR scanning requires `BarcodeDetector` support in the browser.
- If Home Assistant integration is configured, clicking **Migrate**/**Force migration** captures a pre‑migration snapshot and will not proceed without it.

## Development workflow
After any change, bump the next beta version (e.g. `1.0.1b2`), commit, and run `git push`.
