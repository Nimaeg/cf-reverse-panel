# Validation — 0.3.0

Date: 2026-10-25. This is a local engineering validation report, not a record of
deployment to the user's Cloudflare account or Iran server.

## Automated protocol and API checks

`XRAY_BIN=/absolute/path/to/xray npm test` completed with **29 passed, 0 failed,
0 skipped**. Xray was the official Linux v26.10.21 binary, verified against its
release SHA-256 digest. Node v24.22.1 ran the tests.

| Coverage | Result |
| --- | --- |
| Native reverse handshake, real Xray over TCP + TLS | Passed |
| Native reverse handshake, real Xray over WebSocket + TLS | Passed |
| 8 MiB random payload round trip, identical SHA-256, both transports | Passed |
| Stop terminates the channel; reconnect permits new traffic | Passed |
| A regular UUID without reverse permission never reports connected | Passed |
| Four simultaneous TCP streams; excess and private targets fail closed | Passed |
| Encrypted config survives controller recreation | Passed |
| VLESS link / Xray outbound import; incompatible settings rejected | Passed |
| AES-GCM wrong-key and ciphertext-tampering rejection | Passed |
| API authentication, Origin, method and actual-byte body limit | Passed |
| Stop during pending TLS dial does not resurrect the channel | Passed |
| Fragmented handshake, valid control required, DRAIN retirement | Passed |
| Oversized mux metadata rejected before connected state | Passed |
| 18 pre-existing Agent transport/integration/security checks | Passed |

Xray and TLS/TCP were real local processes and sockets. The Cloudflare socket
API adapter and Durable Object storage were substituted with Node equivalents.
The test CA is trusted only by that adapter. Production code never disables
TLS certificate verification. Without XRAY_BIN, the five real-Xray tests are
explicitly skipped; the other 24 still run.

## Browser checks

Playwright with Chromium Headless 134 opened the actual panel assets and routed
API requests through the actual Worker router / NativeController. The controller
connected to a real local Xray over WS+TLS. This was not a canned success API.

Passed: management login, paste-and-submit connection, clearing raw config after
success, no credential storage in localStorage/sessionStorage, disconnect,
reconnect, unsupported REALITY import with existing connection preserved,
deleting persisted config, and logout. No page JavaScript errors occurred.
Screenshots were visually inspected at widths 1440 and 390; mobile had no
horizontal overflow. Screenshots and temporary test keys are not in the archive.

## Build and configuration

`npm run worker:check` successfully bundled the Worker and resolved both
TunnelDO and NativeReverseDO bindings. This is a Wrangler dry run, not a deploy.
The standalone server generator's TCP and WebSocket configurations both passed
`xray run -test`; it generates distinct reverse/user UUIDs and refuses to reuse
an existing output directory.

## Not verified here

- Cloudflare data-center execution and outbound TCP constraints on the user's account.
- The user's public TLS endpoint, network path to Iran, or client routing in 3x-ui.
- User quotas/expiry/accounting, cost, throughput under load, or uptime guarantees.
- REALITY, Vision, UDP, IPv6 and other explicitly unsupported transports.

The environment's earlier `wrangler dev` attempt failed with
`uv_interface_addresses returned Unknown system error 1`. Node interoperability
and the successful build do not resolve that runtime limitation. Follow the
deployment acceptance steps in README.fa.md before relying on the tunnel.
