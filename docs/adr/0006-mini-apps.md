# ADR 0006: Mini-app platform

**Status:** phase 1 accepted and partly built (Stage 7); phase 2 proposed

## Decision
- Phase 1 is a **curated catalogue** of first-party and contracted integrations (food, bookings, tickets). They are reached through server-to-server APIs with OAuth-style scoped consent. No third-party code runs inside the app.
- Phase 2, a **general runtime**, starts only after a dedicated security review. The likely design is a sandboxed webview with a strict CSP, served from a separate origin and talking only through a message bridge, with no direct network access to our API. Each capability (profile, payment request, location) needs its own explicit, revocable user consent and server-side checks.
- Every mini-app has a registered developer, a reviewed version, rate limits, monitoring, and a kill switch.
- Mini-apps never receive access tokens, contacts, or message content. A payment request opens our own checkout UI. The mini-app gets only the result.

## Built in Stage 7
- The catalogue: admins add an integration as a draft, review and publish it, and can switch it off for everyone (the kill switch). Asking for more scopes sends it back to review. People connect it by ticking the scopes they allow, see what they granted, and revoke it.
- Scopes are a fixed list (`profile.basic`, `email`, `orders.read`, `bookings.read`, `notifications.send`) enforced by a database check. None covers messages, contacts or tokens.
- `IntegrationsService.hasGrant` is the one check a partner API must call before returning anything.

## Not built yet
- The partner-facing API itself (OAuth-style client credentials per partner, rate limits, monitoring). It needs a first signed partner to design against.
- Phase 2, the sandboxed runtime.
