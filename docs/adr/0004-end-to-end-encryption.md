# ADR 0004: End-to-end encryption

**Status:** proposed, and **blocked on the licence review below**. Stage 3 messaging shipped without end-to-end encryption (see "Stage 3 as shipped"). Nothing in the code is end-to-end encrypted.

## Stage 3 as shipped (2026-10-26)
- Messages, reactions and media are encrypted **in transit** (TLS, set up at deployment) and stored **readable by the server** in Postgres and object storage. Encryption at rest depends on the database volume and the bucket's own encryption settings. **None of this is end-to-end encryption**, and the apps say "Not end-to-end encrypted yet".
- We did not add libsignal, because its AGPL-3.0 licence still needs legal review (open question 1). We will not substitute a home-grown scheme.
- Some features currently depend on the server reading content: server-side search, reply previews, and the file-signature check on uploads. When E2EE lands, these move to the client: search runs over the local store, previews are built from decrypted messages, and the server can check only sizes and limits, never content.
- The sync design does not depend on content. Per-conversation counters, `clientId` deduplication, receipts and the change feed work unchanged on opaque ciphertext envelopes. E2EE will add per-device envelopes (one ciphertext per recipient device) alongside the existing message row.
- Account deletion wipes the user's messages for everyone. Under E2EE, the server will delete the ciphertext it holds, but copies already on recipients' devices stay there. The app must say so.

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
