# Zigbee2MQTT Migration tool

Migration helper for multiple Zigbee2MQTT instances. Stores IEEE -> name mappings, keeps device names across networks, and assists during migration/pairing.

## How to use
This tool helps migrate devices between Zigbee2MQTT instances (not fully automatic).

1. Enable pairing in exactly one instance (inside Zigbee2MQTT).
2. Click “Migrate” to remove the device from its current instance.
3. Put the device into pairing mode and wait for the interview to finish.
4. The previous name is applied automatically after the join completes.

Reset mappings reloads names from all instances.
Apply mappings prompts for mismatches and applies changes on approval.

## Features
- Persistent IEEE -> name mapping stored in `/data/ieee-map.json`
- Install codes stored in `/data/install-codes.json` with apply-to-instance action
- Aggregated device list with online/availability, linkquality, and instance membership
- Recent activity with highlighted join/leave/rename events
- Pairing status banner with remaining time and warning for multiple instances
- Migration button to remove devices from an instance during pairing
- Apply mappings workflow with confirmation dialog for mismatches

## UI
- Device mappings table with sorting, search (name + IEEE), and instance filters
- Install code editor with QR scan (when supported by the browser)
- Unassigned devices are kept visible and marked offline

## Configuration
Use the same instance URLs and optional tokens as the aggregated UI add-on:
- `server_one..server_four`
- `auth_token_one..auth_token_four`
- `label_one..label_four`

## Notes
- Install code “Add to…” sends `bridge/request/install_code/add` to the selected instance.
- QR scanning requires `BarcodeDetector` support in the browser.
