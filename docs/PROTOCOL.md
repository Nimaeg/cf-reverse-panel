# CFR v2 protocol
Direction of establishment: Cloudflare DO -> public HTTPS Iran relay -> local Agent.
Handshake headers: x-tunnel-token, x-cfr-version=2, x-cfr-channel=0..7. Redirects are not followed.
Binary frame: one byte opcode, four bytes big-endian stream ID, then payload. ID zero is reserved for heartbeats.
Opcodes: OPEN=1 JSON {host,port}; DATA=2; FIN=3; RESET=4; OK=5; ERROR=6; ACK=7 uint32 byte credit; PING=8; PONG=9.
Per-direction initial credit 131072 bytes; DATA <=16384 bytes. Receiver replenishes credit only after its TCP write completes. FIN is a half-close, RESET closes both directions. At most four streams, including pending opens, per channel. IDs are never reused on a channel. Unknown late frames are ignored; malformed frames terminate the channel. Agent never accepts peer-initiated OPEN. Only Worker creates destination connections. No retransmission or stream resumption across reconnects.
Secrets are independent for management and relay. SOCKS is unauthenticated on loopback and must not be exposed. Target syntax rejects private/reserved IPv4 and IPv6; Cloudflare enforces restrictions on resolved destinations. Node tests map a public test name to loopback exclusively in the test adapter.
