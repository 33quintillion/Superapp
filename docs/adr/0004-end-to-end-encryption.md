# ADR 0004: End-to-end encryption (planned for Stage 3)

**Status:** proposed. Nothing in the code is end-to-end encrypted yet.

## Decision (proposed)
- One-to-one and small-group messages will use the **Signal protocol** (X3DH or PQXDH key agreement plus the Double Ratchet) through **libsignal**, the audited reference implementation. We will not write our own cryptography.
- Flutter will bind to libsignal's Rust core through FFI. Web will use libsignal's WebAssembly or TypeScript build, subject to review of its support status. If a platform cannot use libsignal, E2EE will not be offered there; we will not substitute a home-grown scheme.
- The server stores identity keys, signed prekeys and one-time prekeys for each **device**, and relays opaque ciphertext envelopes. It cannot read message content.
- **Multi-device:** every device has its own identity, and senders encrypt to each recipient device ("client fan-out"). Adding a device requires approval from an existing device, or else it does not get history.
- **Groups:** Signal sender keys up to a size limit we will set after load testing. We will assess **MLS (RFC 9420)** for large groups and communities. Large public channels and communities will **not** be E2EE, and the app will say so.
- **Backups:** history backups will be optional and encrypted on the client with a key the user holds (recovery code or passphrase). If the user loses it, the history cannot be recovered, and the app will tell them this plainly.

## What the server will still see (metadata)
Account identifiers, who talks to whom and when, group membership, message sizes and timestamps, IP addresses, device push tokens, and anything a user reports, which the reporter's client sends deliberately. This will be documented for users. Admins get no hidden way to read content.

## Open questions before Stage 3
- Whether libsignal's licence (AGPL-3.0) suits the product's distribution model. **This needs legal review.**
- Key transparency or safety-number verification UX.
