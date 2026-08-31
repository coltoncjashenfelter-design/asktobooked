# asktobooked — Homeowner Continuity v0.3

This build changes the center of the product from "marketing monitoring" to **homeowner continuity**:

> contractor wins a homeowner → job becomes a Home record → asktobooked detects the next need → homeowner routes back to the contractor → revenue is attributed → the relationship compounds.

**v0.2 made D1 the source of truth.** The dashboard loads the account through `GET /api/bootstrap`, every mutation goes through an API route, and the screen is re-rendered from what the backend actually persisted. Browser storage is now only a demo/offline fallback and a cached snapshot.

**v0.3 adds contractor authentication and tenant isolation.** Every dashboard route derives the set of organizations the caller may touch from their session; an `organization_id` sent by the browser is only used after it has been checked against that set.

## Running against D1

```bash
npm install
npx wrangler d1 create asktobooked
```

Copy the returned database ID into `wrangler.jsonc`, then:

```bash
npm run db:migrate:local   # apply migrations/0001 and 0002
npm run dev                # wrangler pages dev . (http://localhost:8788)
npm run db:seed:local      # seed the demo account and print its login
```

Open <http://localhost:8788/dashboard.html>. Without a session you are sent to
`login.html`; sign in with the credentials `db:seed:local` prints, or use
**Create account** to register a brand new organization.

To load a different account you belong to, use `dashboard.html?organization_id=org_xxx`,
or use the organization switcher in the sidebar when your user is a member of more
than one. Requesting an organization you are not a member of returns 403.

## Authentication and tenant isolation

Contractors authenticate with an **opaque session token in an HttpOnly,
SameSite=Strict cookie**. Only the SHA-256 of that token is stored, so read
access to D1 does not hand over live sessions, and logout deletes the row so a
captured cookie cannot be replayed. Passwords are PBKDF2-SHA-256 with a
per-user salt; the iteration count is stored alongside each hash so it can be
raised later without invalidating existing credentials.

Access is granted only by an explicit `organization_members` row. There is no
implicit access and no default organization:

| Situation | Response |
| --- | --- |
| No session | `401` |
| Signed in, named an organization you are not a member of | `403` |
| Signed in, used another tenant's opaque resource id | `404` — the API never confirms that another tenant's id exists |

Homeowners are deliberately **not users**. A Home Record is a capability URL
scoped to exactly one property; it is never accepted as a contractor session,
and the homeowner response is an explicit allow-list of fields rather than a
`SELECT *`, so contractor pricing inputs, dedupe keys, marketing-consent state,
and every other property in the account stay out of it. Revoked and expired
tokens are rejected.

Because the session is a cookie, mutations are also protected against CSRF:
`SameSite=Strict` plus an `Origin` check on every non-GET request.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `ALLOW_SIGNUP` | `"true"` | Self-serve registration. Registration only ever creates a **new** organization owned by the registrant; it can never join an existing one. Set `"false"` to make accounts invite-only. |
| `ALLOW_DEMO_SEED` | `"false"` | `POST /api/demo/seed`. **Off unless explicitly set to `"true"`**, so it cannot run in production by accident. |
| `DEMO_PASSWORD` | `asktobooked-demo` | Password for the seeded demo login. Set with `wrangler pages secret put DEMO_PASSWORD`. |

Cloudflare recommends `wrangler.jsonc` for new Workers/Pages configurations. D1 is accessed from a Pages Function through the `DB` binding.

### Without a backend

Serving the folder from any static web server still works:

```bash
python3 -m http.server 8788
# open http://localhost:8788/dashboard.html
```

With no API responding, the app announces offline mode in a banner and runs the
52-home demo workspace out of browser storage. Nothing written in that mode is
durable, and the sidebar/status pill say so.

If the backend disappears mid-session, the app instead shows the last synced
snapshot of the real account and goes **read-only**: those records belong to D1,
so accepting edits into browser storage would either be discarded on reconnect
or collide with the server's opportunity de-duplication. Mutations are refused
with a clear message until the connection returns.

## Data flow

```text
dashboard.html ──▶ app.js ──▶ data.js (adapter) ──▶ /api/* (Pages Function) ──▶ D1
home.html      ──▶ home.js ─────────┘
core.js  (pure rules, metrics, CSV parsing — no I/O)
```

`data.js` is the only place that talks to the network or to browser storage:

- `createStore()` owns the contractor dashboard account state.
- `createHomeRecordStore()` owns the homeowner-facing Home Record.
- Both expose `subscribe()`, a `status` object (`mode`, `loading`, `syncing`, `error`, `warning`, `needsSeed`, `readOnly`, `unauthenticated`), and mutation methods.
- `createStore().load()` reads `GET /api/auth/session` first, so the organization and the identity shown in the sidebar come from the session rather than from a default baked into the client. A `401` sets `status.unauthenticated`, which `app.js` turns into a redirect to `login.html` — it is never mistaken for the offline fallback.
- Every remote mutation is followed by a fresh `GET /api/bootstrap`, so the UI can never drift from what was persisted.
- Server rows are mapped into the shape `core.js` already understood, so the rules engine, metrics, and audit scoring are unchanged.

## What works

- **Overview** — Homes Under Care, identified opportunity, recovered revenue, continuity rate.
- **Homes** — persistent property-centric relationship table and detailed home records.
- **Opportunities** — prioritized revenue queue with confidence, value, reasons, booking attribution, dismissal.
- **Automations** — enabled/disabled lifecycle rules; real messaging intentionally remains off pre-launch.
- **Visibility** — the existing AI/local discovery layer preserved as acquisition, not the product category.
- **Homeowner Continuity Audit** — Acquisition / Conversion / Revenue Retention / Continuity score, derived from persisted state.
- **CSV Import** — posts parsed rows to `/api/jobs/import`, which persists Homeowners, Properties, Assets, Service Events, Home Records, and re-runs the Opportunity Engine.
- **Home Record** — homeowner-facing property/equipment/service-history page; claim and booking both persist.
- **Settings** — business configuration persisted through `PATCH /api/organizations/:id`.

The demo account is intentionally dense enough to show the product: 52 Homes Under Care, aging equipment, open estimates, maintenance gaps, repeat customers, Home Record claim states, and historical recovered revenue.

## Opportunity Engine

The engine exists twice on purpose, with identical rules and identical `dedupe_key` values:

- `functions/api/[[path]].js` — the authoritative SQL implementation. It runs on
  `POST /api/opportunities/recalculate` and after every import, and it writes
  opportunities into D1.
- `core.js` — the same rules in memory, used for the offline/demo fallback and
  for the deterministic unit tests.

Rules:

1. **Maintenance due** — installed asset with no maintenance/service basis in 330+ days.
2. **Replacement window** — equipment 12+ years old; confidence increases for age 16+ or repeated repairs.
3. **Open estimate** — open estimate at least 7 days old.
4. **Dormant homeowner** — prior paying relationship with no completed service in 24 months.
5. **Continuity gap** — recent completed job but no claimed Home Record.
6. **Membership opportunity** — repeat paid service history with no recorded active membership.

Repeated runs do not create duplicates, and closed/booked/won/dismissed opportunities are never reopened by a recalculation.

## CSV format

Minimum useful columns:

```csv
first_name,last_name,email,phone,address,city,state,zip,job_date,job_type,amount
```

Extra supported columns for installations:

```csv
manufacturer,model,serial_number,warranty_expiration,estimated_lifespan_years
```

See `sample-import.csv`. Imports deduplicate homes by normalized address.

## API routes

Schema: `migrations/0001_home_graph.sql` and `migrations/0002_auth.sql`.
Implementation: `functions/api/[[path]].js`.

**Auth** is the column that matters: `session` means a contractor session is
required and the organization is derived from it; `token` means a Home Record
capability token; `public` means no credentials.

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | public | binding/connectivity check |
| POST | `/api/auth/register` | public | create a user + a new organization (`ALLOW_SIGNUP`) |
| POST | `/api/auth/login` | public | start a session |
| POST | `/api/auth/logout` | public | delete the session row and clear the cookie |
| GET | `/api/auth/session` | session | current user and their organizations |
| GET | `/api/bootstrap?organization_id=…` | session | full account read (also accepts `?slug=`; defaults to your own first organization) |
| GET | `/api/organizations` | session | organizations this session can reach |
| PATCH | `/api/organizations/:id` | session | business settings |
| GET | `/api/homes?organization_id=…` | session | denormalized home list |
| GET | `/api/homes/:property_id` | session | single home detail |
| POST | `/api/homes/:property_id/home-record` | session | create Home Record access if missing |
| GET | `/api/opportunities?organization_id=…&status=…` | session | opportunity queue |
| POST | `/api/opportunities/recalculate` | session | run the engine, persist results |
| POST | `/api/opportunities/:id/book` | session | booking + attribution interaction |
| POST | `/api/opportunities/:id/dismiss` | session | dismissal + interaction |
| PATCH | `/api/automation-rules/:id` | session | enable/disable a rule |
| POST | `/api/visibility/snapshots` | session | add a visibility snapshot |
| POST | `/api/visibility/queries` | session | add a tracked buyer question |
| POST | `/api/jobs/import` | session | import parsed CSV rows, then recalculate |
| GET | `/api/home-record/:token` | token | homeowner-facing record for one property |
| POST | `/api/home-record/:token/claim` | token | claim + interaction |
| POST | `/api/home-record/:token/book` | token | homeowner booking |
| POST | `/api/demo/seed` | public, gated | generate the demo account (`ALLOW_DEMO_SEED`) |

`POST /api/demo/seed` only ever touches the fixed `org_nwha` demo organization,
and is refused unless `ALLOW_DEMO_SEED` is exactly `"true"`. It also provisions
the demo contractor login, and when called from an authenticated dashboard it
grants that user access to the seeded account.

## Tests

```bash
npm test
```

- `tests/core.test.cjs` — the rules engine, demo generation, in-memory CSV import.
- `tests/data.test.cjs` — the data adapter: row mapping, API-is-authoritative behaviour, mutations over HTTP, error surfacing, offline fallback, empty/seed state, sign-out and session expiry, Home Record store.
- `tests/api.test.cjs` — persistence, through the real Pages Function handler: seeding, import, recalculation, booking, claiming, and read-back after each write.
- `tests/auth.test.cjs` — authentication and tenant isolation: two organizations created through the real register/login routes, then every dashboard surface probed from the wrong session.

The last two run against an in-memory SQLite database built from the migrations
via `tests/harness.cjs`, which also gives each simulated browser its own cookie
jar. They need `node:sqlite` (Node 24+, or Node 22.5+ via
`node --experimental-sqlite …`) and skip themselves otherwise.

## Remaining security risks

Authentication and tenant isolation are in place, but these are still open:

- **No rate limiting on login.** Password guessing is only slowed by PBKDF2. Add a Durable Object or KV counter, or Cloudflare Rate Limiting, before exposing this publicly.
- **PBKDF2 at 100,000 iterations.** Production Workers rejects higher counts, which is below the OWASP recommendation of 600,000 for PBKDF2-SHA-256. The iteration count is stored per hash so it can be raised when the platform allows.
- **No password reset, email verification, or MFA.** Registration trusts the email address it is given.
- **No audit log.** Who changed settings, ran an import, or booked an opportunity is not recorded separately from the interaction rows.
- **Home Record tokens do not expire by default.** The column and the enforcement exist, but seeded and imported tokens are created without an `expires_at`, so a leaked link stays valid until revoked.
- **Roles are stored but not enforced.** `owner`, `admin`, and `member` all currently have identical permissions.
- **Sessions are not revocable in bulk.** Changing a password does not invalidate other sessions.

## Production blockers before real homeowner outreach

Do **not** turn on real automated SMS/email merely because the Automation screen exists. Before outbound messaging:

- homeowner consent + opt-out enforcement
- sender identity and deliverability controls
- audit logging
- rate limiting / abuse prevention
- secrets stored only server-side
- backup/export plan
- data retention/deletion behavior

The current contact-status model already includes `unknown`, `consented`, `transactional_only`, `unsubscribed`, and `invalid` so those controls have somewhere to live.

## Product architecture

See `docs/ARCHITECTURE.md` for the Home Graph and `docs/NEXT_BUILD.md` for the next production sequence.
