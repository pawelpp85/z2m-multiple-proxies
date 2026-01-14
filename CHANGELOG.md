# Changelog

## 1.0.1
- Migration tool: add Force migration flow with blocklist add/remove and automatic rename after configuration.
- Migration tool: stop auto-renaming on mismatch; highlight mismatched names and add “Change to” action.
- Migration tool: show Last seen under Online/Offline (locale time, tooltip-only label).
- Migration tool: remember search + instance filters across refreshes.
- Migration tool: add pairing control (enable/disable, single active instance UI).

## 1.1.0
- Aggregated add-on: switch UI to zigbee2mqtt-windfront.
- Aggregated add-on: improve permit_join routing (IEEE-aware) and countdown handling.
- Aggregated add-on: add fourth backend ("Original") with HA add-on default.
- Docs: add Dockage/Ansible setup example and Zigbee device mapping notes.
- Migration tool: Home Assistant IDs modal with snapshots, entity_id restore, and automation rewrite tools.
- Migration tool: migration flow now auto-saves HA snapshots and blocks without HA config.
- Migration tool: coordinator inventory with saved snapshots, change highlighting, and bulk save.
- Migration tool: migration status UI, pairing safety checks, and install code auto-add on migrate.
- Migration tool: device mappings usability (filters, delete offline entries, compact entity table, links).

## 1.1.1
- Migration tool: never auto-delete mappings when coordinators or devices disappear.

## 1.1.2b1
- Migration tool: avoid false rename status when entity matches are duplicated.

## 1.1.2
- Migration tool: keep devices visible in mappings while they are between instances.

## 1.0.0
- Initial release.
