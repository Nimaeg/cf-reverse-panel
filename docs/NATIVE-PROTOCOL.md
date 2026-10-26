# Native VLESS Reverse, version 0.3

The new panel uses an original JavaScript implementation of Xray VLESS reverse,
not the CFRv2 Agent protocol. The legacy implementation remains under `agent/`,
`shared/mux.mjs`, `worker/controller.mjs`, and `/legacy`.

## Source and interoperability baseline

- Xray-core release tested: **v26.10.21**, commit `1b1647cd9ddf0abc34b981d4611fc03bcac1ca74`.
- Official release archive `Xray-linux-64.zip` SHA-256:
  `0eec3ed4163c273d8c8bf821f7d219e257921cf584aa3fb970715e458e631978`.
  Verified against the release `.dgst` before execution. Binary is not bundled.
- [VLESS inbound and reverse account](https://xtls.github.io/en/config/inbounds/vless.html)
- [VLESS outbound reverse semantics](https://xtls.github.io/en/config/outbounds/vless.html)
- [Xray mux frame source](https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/common/mux/frame.go)
- [Xray reverse portal](https://github.com/XTLS/Xray-core/blob/1b1647cd9ddf0abc34b981d4611fc03bcac1ca74/app/reverse/portal.go)
- [Cloudflare TCP socket API and restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)

## Handshake and readiness

Worker dials the configured public Iran host with verified TLS. It optionally
upgrades to RFC 6455 WebSocket on that same TLS socket. The VLESS request contains
version 0, UUID, no addons, command 4, and no destination. A VLESS response alone
does not establish readiness. The implementation waits for a mux NEW control
session addressed to UDP `reverse:0`, followed by a valid ACTIVE protobuf control
message. This UDP metadata is an internal control stream; it does not open a UDP
socket or enable user UDP traffic.

Reverse Tag is **local configuration**, not a VLESS wire parameter. The server
identifies the authorized reverse account by UUID and chooses that account's
`reverse.tag`. The panel records a label for the operator; it cannot verify tag
equality or modify the server's routing rules. A successful handshake is not a
test of the user's inbound routing, DNS, quota, or actual Internet reachability.

## Transport and resource bounds

Each mux frame starts with a 2-byte metadata length, then a 2-byte stream ID,
status and options. NEW includes network, port, address type and address.
DATA includes a 2-byte payload length. KEEP carries replies; END closes a stream.
Metadata is capped at 512 bytes. Outgoing data is chunked at 8192 bytes. Incoming
payloads are capped by the 16-bit length. There is no credit-window extension:
this must interoperate with standard Xray. The implementation awaits socket
writes and caps its output queue at 1 MiB. WebSocket is framed over the TCP
WritableStream so that writes also observe backpressure. Slow writes can block
other streams on the channel; a write blocked for 15 seconds is terminated.

One native channel permits four active TCP destinations. Public IPv4 literals
and domain names are accepted. Private/reserved literals are blocked; Cloudflare
also restricts private DNS results and connections to Cloudflare IP ranges.
The default target port allowlist is `80,443`. TLS connection and reverse
handshake together time out after 12 seconds. Target connects time out after
8 seconds. Idle streams close after 120 seconds on the next sweep. Heartbeats
are checked by a 15-second alarm; absence for over 45 seconds triggers recovery.
Cloudflare scheduling can delay alarms; these are not SLA guarantees.

The Xray DRAIN control retires a channel after its active streams finish, then
the next alarm/cron reconnects. Existing TCP streams are not resumed. Xray's
native mux END is treated as full close; unlike the legacy custom Agent
protocol, native half-close is not promised. This panel does not emulate Xray's
adaptive pool of multiple reverse channels. CHANNELS controls only the legacy
Agent, not the native bridge.

## Configuration and security boundary

The authenticated management API accepts VLESS links or exactly one Xray VLESS
outbound. TLS is mandatory; `encryption=none` and empty flow are required. Only
raw/TCP and WebSocket are implemented. REALITY, Vision, VLESS Encryption,
XHTTP, gRPC, IPv6, user UDP, HTTP disguise, early data, custom ALPN and
chain/proxy settings are rejected. An imported TLS fingerprint is not applied;
the UI warns that Worker uses its standard TLS implementation. The connection
host must equal SNI because this adapter does not configure independent TLS SNI.

API access requires a random ADMIN_TOKEN of at least 32 characters. Authentication
uses SHA-256 digests and a fixed-length comparison. Browser requests with a foreign
Origin are rejected. JSON bodies are byte-counted and limited to 70,000 bytes.
Config and labels are rendered with textContent. The browser keeps the token in
memory only; no credential is saved in localStorage/sessionStorage. The stored
config is AES-GCM encrypted using a key derived from ADMIN_TOKEN and a random
IV. The authenticated status API never returns UUID or raw input. This protects
stored values from casual inspection; it is not independent key management or
protection against an administrator controlling both code and secrets.

Disconnect persists disabled state. Forget deletes the active config key.
Changing ADMIN_TOKEN requires re-entering the config because old ciphertext can
no longer be decrypted. Alarm plus minutely cron recover enabled channels after
disconnects/DO restarts. Hosting and real network execution require deployment
to Cloudflare; a static web host cannot run the backend.
