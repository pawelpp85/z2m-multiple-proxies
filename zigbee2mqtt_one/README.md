# Zigbee2MQTT One (Proxy)

Ingress-enabled nginx reverse proxy that exposes an existing Zigbee2MQTT UI instance already running elsewhere. Configure `server` (full URL **without** a trailing slash) and optional `auth_token`; the proxy will forward ingress traffic to that address.
