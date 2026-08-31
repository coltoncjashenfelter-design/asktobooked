# Next build sequence

The current folder is a working pre-launch product loop. Do the following next, in order.

## 1. Make D1 the source of truth — done in v0.2

`data.js` is the single read/write path, the dashboard boots from `GET /api/bootstrap`, and every mutation persists through an API route before the UI re-renders. Browser storage is a demo/offline fallback only.

Remaining follow-ups: opportunity-status filtering server-side rather than in the browser, pagination for accounts far beyond a few thousand homes, and a partial-refresh path so mutations do not re-read the whole account.

## 2. Add authentication and tenant authorization — done in v0.3

Contractors sign in against `users`/`organization_members`/`sessions`; every dashboard route derives the permitted organizations from the session, and Home Record tokens expose only an explicit homeowner-facing projection of a single property.

Remaining follow-ups, in rough priority order: rate limiting on login, password reset and email verification, enforcing the `owner`/`admin`/`member` roles that are already stored, an audit log, invalidating a user's other sessions on password change, and setting `expires_at` on newly issued Home Record tokens.

## 3. Add production onboarding/import

- team invitations, so an organization can have more than its founding user
- CSV preview + column mapping
- validation/error row export
- idempotent external IDs
- larger-file/background import path
- CRM-specific adapters later

## 4. Turn the Opportunity Engine into an auditable service

Persist rule runs, engine version, trigger evidence, created/dismissed reason, and manual overrides. Do not present inferred value as guaranteed revenue.

## 5. Add Home Record invitation workflow

Start with transactional invitations from selected completed jobs. Enforce contact-status rules. Track invite → view → claim → booking.

## 6. Add real booking integration

Use each contractor's existing booking URL first. Add webhook/API integrations later. Record click and confirmed-booking states separately so attribution stays honest.

## 7. Add document storage

R2 is a natural home for invoices, warranty PDFs, manuals, photos, and service documents. Store only object keys/metadata in D1.

## 8. Rebuild prospecting around the Continuity Audit

For each HVAC prospect, score:

1. Acquisition
2. Conversion
3. Revenue Retention
4. Homeowner Continuity

The audit should open directly into a pre-populated account/demo rather than exist as a disconnected PDF.

## Deliberately later

Do not build a marketplace, contractor bidding, native homeowner apps, smart-home integrations, insurance integrations, utility integrations, or predictive failure ML until the core loop has real usage and longitudinal data.
