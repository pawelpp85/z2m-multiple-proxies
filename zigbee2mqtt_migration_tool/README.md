# Zigbee2MQTT Migration tool

Migration helper for multiple Zigbee2MQTT instances. Stores IEEE -> name mappings, keeps device names across networks, and assists during migration/pairing.

## How to use
This tool helps migrate devices between Zigbee2MQTT instances, but it is not fully automatic.

Configure the add-on with URLs for all your instances. The tool discovers devices, IEEE addresses, and names, and stores the mapping for future moves. Use the mapped name here instead of renaming directly in Zigbee2MQTT.

Before migrating, make sure an install code is stored for the device. Install codes are saved per IEEE address and can be scanned with the camera and added to the target instance.

1. Enable pairing in exactly one Zigbee2MQTT instance (do this in that instance, not here).
2. Click “Migrate” for the device to remove it from its current instance.
3. Put the device into pairing mode and follow the manufacturer or Zigbee2MQTT instructions.
4. After the device joins the new instance and finishes the interview, the previous name is applied automatically.

Reset mappings reloads current names from all instances and removes mappings for devices not present in any instance.
Apply mappings checks for mismatched names and lets you confirm proposed changes.

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
