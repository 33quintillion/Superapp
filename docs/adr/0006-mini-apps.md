# ADR 0006: Mini-app platform (planned for Stage 7)

**Status:** proposed

## Decision
- Phase 1 is a **curated catalogue** of first-party and contracted integrations (food, bookings, tickets). They are reached through server-to-server APIs with OAuth-style scoped consent. No third-party code runs inside the app.
- Phase 2, a **general runtime**, starts only after a dedicated security review. The likely design is a sandboxed webview with a strict CSP, served from a separate origin and talking only through a message bridge, with no direct network access to our API. Each capability (profile, payment request, location) needs its own explicit, revocable user consent and server-side checks.
- Every mini-app has a registered developer, a reviewed version, rate limits, monitoring, and a kill switch.
- Mini-apps never receive access tokens, contacts, or message content. A payment request opens our own checkout UI. The mini-app gets only the result.
