/**
 * API persistence tests.
 *
 * Runs the real Pages Function handler against an in-memory SQLite database
 * created from migrations/0001_home_graph.sql, through a small D1-shaped shim.
 * Every assertion re-reads through GET /api/bootstrap, which is exactly what a
 * browser refresh or a second browser session does.
 *
 * Requires node:sqlite (Node 24+, or Node 22.5+ with --experimental-sqlite).
 */
const assert = require('assert');
const { createHarness } = require('./harness.cjs');

async function main() {
  const h = await createHarness();
  if (!h) {
    console.log('SKIP asktobooked api tests — node:sqlite is unavailable. Use Node 24+, or run: node --experimental-sqlite tests/api.test.cjs');
    return;
  }
  const { sqlite, worker, DB, core: C, client } = h;

  // One signed-in contractor performs every request below, exactly as the
  // dashboard does. Persistence is what is under test here; tenant isolation is
  // covered in auth.test.cjs.
  const operator = client();
  await operator.register({ email: 'operator@northwestheating.example', password: 'operator-password-1', name: 'Operator', organization_name: 'Operator Co' });
  const call = (method, route, body, overrides) => operator.call(method, route, body, overrides);
  const ok = async (method, route, body, overrides) => {
    const result = await call(method, route, body, overrides);
    assert.strictEqual(result.payload.ok, true, `${method} /api/${route} failed: ${JSON.stringify(result.payload)}`);
    return result.payload.data;
  };
  const account = () => ok('GET', `bootstrap?organization_id=org_nwha`);

  /* --- Health and empty-database behaviour ---------------------------- */
  assert.strictEqual((await call('GET', 'health')).payload.database, 'connected');
  assert.strictEqual((await call('GET', 'bootstrap?organization_id=org_nwha')).status, 403, 'an organization you are not a member of is never readable');
  assert.strictEqual((await call('GET', 'bootstrap?slug=does-not-exist')).status, 404, 'an unknown slug is a 404, not a crash');

  /* --- Seeding writes a complete account into D1 ---------------------- */
  const seeded = await ok('POST', 'demo/seed', { reset: false });
  assert.strictEqual(seeded.demo_user_email, 'owner@northwestheating.example', 'seeding provisions a contractor login');
  assert.strictEqual(seeded.seeded, true);
  assert.strictEqual(seeded.unique_homes, 52, 'the demo account seeds 52 homes');
  assert.ok(seeded.open_opportunities > 0, 'the Opportunity Engine persisted opportunities during seeding');

  const initial = await account();
  assert.strictEqual(initial.organization.name, 'Northwest Heating & Air');
  assert.strictEqual(initial.properties.length, 52);
  assert.strictEqual(initial.homeowners.length, 52);
  assert.strictEqual(initial.assets.length, 52);
  assert.strictEqual(initial.automationRules.length, 6, 'default automation rules are provisioned');
  assert.strictEqual(initial.visibility.snapshots.length, 3);
  assert.ok(initial.opportunities.some(o => o.type === 'maintenance_due'), 'maintenance rule fired');
  assert.ok(initial.opportunities.some(o => o.type === 'replacement_window'), 'replacement rule fired');
  assert.ok(initial.opportunities.some(o => o.type === 'open_estimate'), 'estimate rule fired');
  assert.ok(initial.opportunities.some(o => o.type === 'continuity_gap'), 'continuity rule fired');
  assert.ok(initial.opportunities.some(o => o.status === 'won'), 'seeded recovered revenue exists');
  assert.ok(initial.bookings.length >= 4, 'recovered revenue is backed by booking rows');

  const reseeded = await ok('POST', 'demo/seed', { reset: false });
  assert.strictEqual(reseeded.seeded, false, 'seeding is idempotent without reset');
  assert.strictEqual((await account()).properties.length, 52, 'a repeat seed does not duplicate homes');

  assert.strictEqual((await call('POST', 'demo/seed', {}, { env: { ALLOW_DEMO_SEED: 'false' } })).status, 403, 'seeding can be disabled per environment');

  /* --- Recalculation persists generated opportunities ---------------- */
  const engine = await ok('POST', 'opportunities/recalculate', { organization_id: 'org_nwha' });
  assert.ok(engine.open_opportunities > 0);
  const afterRecalculation = await account();
  assert.strictEqual(afterRecalculation.opportunities.length, initial.opportunities.length, 'recalculation is deduplicated, not duplicated');
  assert.ok(afterRecalculation.opportunities.every(o => o.dedupe_key), 'every persisted opportunity carries a dedupe key');
  assert.strictEqual(afterRecalculation.opportunities.filter(o => o.status === 'won').length, initial.opportunities.filter(o => o.status === 'won').length, 'resolved opportunities are not reopened');

  /* --- CSV import persists homes, history and opportunities ---------- */
  const recentJobDate = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const rows = C.parseCSV(`first_name,last_name,email,phone,address,city,state,zip,job_date,job_type,amount\nAvery,Stone,avery.stone@example.com,(360) 555-7788,4120 Sunrise Way,Bellingham,WA,98226,${recentJobDate},Heat Pump Installation,11400`);
  const imported = await ok('POST', 'jobs/import', { organization_id: 'org_nwha', rows });
  assert.strictEqual(imported.jobs_imported, 1);
  assert.strictEqual(imported.new_homes, 1);
  assert.strictEqual(imported.unique_homes, 53);

  const afterImport = await account();
  assert.strictEqual(afterImport.properties.length, 53, 'the imported home is readable after a refresh');
  const importedProperty = afterImport.properties.find(p => p.address_line_1 === '4120 Sunrise Way');
  assert.ok(importedProperty, 'the imported home is persisted');
  assert.ok(afterImport.assets.some(a => a.property_id === importedProperty.id), 'the installation created a persisted asset');
  assert.ok(afterImport.serviceEvents.some(e => e.property_id === importedProperty.id), 'the imported job is persisted as a service event');
  assert.ok(afterImport.homeRecordAccess.some(a => a.property_id === importedProperty.id), 'the imported home gets a Home Record token');
  assert.ok(afterImport.opportunities.some(o => o.property_id === importedProperty.id && o.type === 'continuity_gap'), 'the engine ran over the imported home and found the unclaimed Home Record');

  await ok('POST', 'jobs/import', { organization_id: 'org_nwha', rows });
  assert.strictEqual((await account()).properties.length, 53, 'a repeat import deduplicates by normalized address');
  assert.strictEqual((await call('POST', 'jobs/import', { organization_id: 'org_missing', rows })).status, 403, 'imports are scoped to an organization the session can reach');

  /* --- Booking an opportunity from the dashboard --------------------- */
  const target = afterImport.opportunities.find(o => o.status === 'open');
  const booking = await ok('POST', `opportunities/${target.id}/book`, { source: 'contractor_dashboard' });
  assert.ok(booking.booking_id);

  const afterBooking = await account();
  const bookedOpportunity = afterBooking.opportunities.find(o => o.id === target.id);
  assert.strictEqual(bookedOpportunity.status, 'booked', 'booking status survives a refresh');
  assert.ok(bookedOpportunity.resolved_at, 'the resolution timestamp is persisted');
  assert.ok(afterBooking.bookings.some(b => b.opportunity_id === target.id), 'a booking row is persisted');
  assert.ok(afterBooking.interactions.some(i => i.opportunity_id === target.id && i.type === 'booking_request'), 'the booking is attributable');

  const recoveredBefore = C.sum(afterImport.opportunities.filter(o => ['booked','won'].includes(o.status)), o => o.actual_value || o.estimated_value);
  const recoveredAfter = C.sum(afterBooking.opportunities.filter(o => ['booked','won'].includes(o.status)), o => o.actual_value || o.estimated_value);
  assert.strictEqual(recoveredAfter, recoveredBefore + Number(target.estimated_value), 'recovered revenue reflects the persisted booking');

  await ok('POST', 'opportunities/recalculate', { organization_id: 'org_nwha' });
  assert.strictEqual((await account()).opportunities.find(o => o.id === target.id).status, 'booked', 'a later engine run does not reopen a booked opportunity');

  /* --- Dismissal ------------------------------------------------------ */
  const dismissTarget = afterBooking.opportunities.find(o => o.status === 'open' && o.id !== target.id);
  await ok('POST', `opportunities/${dismissTarget.id}/dismiss`, {});
  assert.strictEqual((await account()).opportunities.find(o => o.id === dismissTarget.id).status, 'dismissed');
  assert.strictEqual((await call('POST', 'opportunities/opp_missing/book', {})).status, 404);

  /* --- Settings, automations and visibility --------------------------- */
  await ok('PATCH', 'organizations/org_nwha', { name: 'Northwest Heating & Air Co', average_job_value: 5200, booking_url: 'https://booking.example/schedule' });
  const afterSettings = await account();
  assert.strictEqual(afterSettings.organization.name, 'Northwest Heating & Air Co');
  assert.strictEqual(afterSettings.organization.average_job_value, 5200);
  assert.strictEqual(afterSettings.organization.slug, 'northwest-heating-air', 'unsupplied fields are left alone');

  const rule = afterSettings.automationRules[0];
  await ok('PATCH', `automation-rules/${rule.id}`, { enabled: false });
  assert.strictEqual((await account()).automationRules.find(r => r.id === rule.id).enabled, 0, 'automation toggles persist');

  await ok('POST', 'visibility/snapshots', { organization_id: 'org_nwha', snapshot_date: '2026-08-30', ai_mention_rate: 64, local_visibility: 75, website_conversion: 4.9, qualified_leads: 44, booked_jobs: 17, new_reviews: 6, response_minutes: 12 });
  await ok('POST', 'visibility/queries', { organization_id: 'org_nwha', query_text: 'ductless mini split Bellingham', platform: 'Perplexity', status: 'Missed' });
  const afterVisibility = await account();
  assert.strictEqual(afterVisibility.visibility.snapshots.length, 4);
  assert.strictEqual(afterVisibility.visibility.queries.length, 5);
  assert.strictEqual((await call('POST', 'visibility/queries', { organization_id: 'org_nwha' })).status, 400, 'query text is required');

  /* --- Home Record claim and booking ---------------------------------- */
  const invited = afterVisibility.homeRecordAccess.find(a => a.status === 'invited');
  const record = await ok('GET', `home-record/${encodeURIComponent(invited.token)}`);
  assert.strictEqual(record.property.id, invited.property_id);
  assert.strictEqual(record.organization.id, 'org_nwha');

  await ok('POST', `home-record/${encodeURIComponent(invited.token)}/claim`, {});
  const afterClaim = await account();
  assert.strictEqual(afterClaim.homeRecordAccess.find(a => a.token === invited.token).status, 'claimed', 'the claim survives a refresh');
  assert.ok(afterClaim.interactions.some(i => i.type === 'home_record_claimed' && i.property_id === invited.property_id), 'the claim is recorded as an interaction');
  assert.strictEqual((await call('POST', 'home-record/not-a-token/claim', {})).status, 404);

  const homeownerBooking = record.opportunities[0];
  if (homeownerBooking) {
    await ok('POST', `home-record/${encodeURIComponent(invited.token)}/book`, { opportunity_id: homeownerBooking.id });
    const afterHomeownerBooking = await account();
    assert.strictEqual(afterHomeownerBooking.opportunities.find(o => o.id === homeownerBooking.id).status, 'booked', 'homeowner bookings persist');
    assert.ok(afterHomeownerBooking.bookings.some(b => b.opportunity_id === homeownerBooking.id));
  }

  /* --- Ensuring Home Record access for a home that has none ----------- */
  sqlite.exec("DELETE FROM home_record_access WHERE property_id = 'nwha_property_1'");
  const created = await ok('POST', 'homes/nwha_property_1/home-record', {});
  assert.strictEqual(created.status, 'invited');
  assert.ok(created.token);
  const repeat = await ok('POST', 'homes/nwha_property_1/home-record', {});
  assert.strictEqual(repeat.token, created.token, 'Home Record access is created once, not on every open');
  assert.strictEqual((await call('POST', 'homes/nope/home-record', {})).status, 404);

  /* --- Organization discovery and a full "second session" read -------- */
  const organizations = await ok('GET', 'organizations');
  assert.ok(organizations.some(o => o.id === 'org_nwha'), 'the seeded account is listed for the session that seeded it');
  assert.ok(organizations.every(o => o.role), 'each listed organization carries the caller\'s role');

  const secondSession = await ok('GET', 'bootstrap?slug=northwest-heating-air');
  assert.strictEqual(secondSession.organization.id, 'org_nwha', 'an account can also be resolved by slug');
  assert.strictEqual(secondSession.properties.length, 53);
  assert.strictEqual(secondSession.opportunities.find(o => o.id === target.id).status, 'booked');
  assert.strictEqual(secondSession.organization.name, 'Northwest Heating & Air Co');

  assert.strictEqual((await call('GET', 'nope')).status, 404, 'unknown routes 404');
  assert.strictEqual((await worker.onRequest({ request: new Request('http://localhost/api/health'), env: { DB: undefined } })).status, 503, 'a missing D1 binding is reported, not fatal');
  assert.ok(DB, 'the harness exposes the D1 shim');

  h.close();
  console.log('asktobooked api persistence tests passed', { homes: secondSession.properties.length, opportunities: secondSession.opportunities.length });
}

main().catch(error => { console.error(error); process.exit(1); });
