# Changelog

## v0.3.0 — Authentication and tenant isolation

- Added contractor authentication: PBKDF2-SHA-256 passwords and opaque session tokens delivered in an HttpOnly, SameSite=Strict cookie and stored only as a SHA-256 digest.
- Added `migrations/0002_auth.sql` with `users`, `organization_members`, and `sessions`.
- Every dashboard route now derives the permitted organizations from the session; an `organization_id` from the browser is only used after it is checked against that set (401 unauthenticated, 403 unauthorized organization, 404 for another tenant's opaque resource ids).
- `GET /api/organizations` now returns only the caller's organizations instead of every organization in the database.
- Narrowed the Home Record response to an explicit homeowner-facing allow-list, and enforced token revocation and expiry. Homeowner bookings can no longer be aimed at another property's opportunity.
- Added `POST /api/auth/register`, `/login`, `/logout`, and `GET /api/auth/session`; added CSRF protection via an `Origin` check on mutations.
- Demo seeding now defaults to **off** unless `ALLOW_DEMO_SEED` is `"true"`, and provisions a demo contractor login instead of an organization nobody can reach.
- Added `login.html`, a sidebar identity/sign-out row, and an organization switcher for multi-organization users; the rest of the UI is unchanged.
- Added `tests/auth.test.cjs` and a shared `tests/harness.cjs` with per-client cookie jars; existing persistence tests now run authenticated.

## v0.2.0 — D1 as the source of truth

- Added `data.js`, a data adapter that owns every read and write for the app.
- Dashboard and Home Record now load from `GET /api/bootstrap` and re-render from persisted server state after each mutation.
- Demoted browser storage to a demo workspace, an offline fallback, and a cached snapshot; it is never authoritative while the API answers.
- Added API routes for organization settings, opportunity booking/dismissal, Home Record provisioning, automation toggles, visibility entries, and account discovery.
- Added server-side demo seeding (`POST /api/demo/seed`, `npm run db:seed:local`) so the Northwest Heating & Air account exists in D1.
- Recorded booking, dismissal, and Home Record claim interactions for attribution.
- Added loading, empty/seedable, offline, and API-error states to the dashboard and Home Record.
- Added data adapter tests and API persistence tests that run the real Pages Function against an in-memory SQLite database.

## v0.1.0 — Homeowner Continuity foundation

- Repositioned product around persistent home relationships.
- Added Home Graph data model.
- Added 52-home HVAC demo account.
- Added deterministic Opportunity Engine with six rule families.
- Added Homes Under Care dashboard.
- Added Home detail/workspace.
- Added Opportunities queue with value, confidence, booking attribution, dismissal.
- Added Home Record homeowner surface with claim and booking actions.
- Added CSV historical-job importer with address deduplication and installation asset creation.
- Added Homeowner Continuity Audit.
- Preserved AI/local visibility as acquisition layer.
- Added automation rule controls with outbound messaging intentionally disabled.
- Added D1 relational schema.
- Added Cloudflare Pages Function API skeleton/engine routes.
- Added sample import file and core tests.
