/**
 * Authentication, session and tenant-isolation tests.
 *
 * Two contractor organizations are created through the real registration and
 * login routes, then every dashboard surface is probed from the wrong session
 * to prove that access is derived from the session rather than from the
 * organization_id the caller sends.
 *
 * Status-code convention under test:
 *   401  no session at all
 *   403  signed in, but named an organization the session does not include
 *   404  signed in, but used another tenant's opaque resource id (the API must
 *        not confirm that the id exists)
 */
const assert = require('assert');
const { createHarness } = require('./harness.cjs');

const PASSWORD_A = 'correct-horse-battery';
const PASSWORD_B = 'another-long-password';

async function main() {
  const h = await createHarness();
  if (!h) {
    console.log('SKIP asktobooked auth tests — node:sqlite is unavailable. Use Node 24+, or run: node --experimental-sqlite tests/auth.test.cjs');
    return;
  }
  const { sqlite, client } = h;

  /* --- Registration establishes a user, an organization and a session --- */
  const alice = client();
  const aliceSession = await alice.register({ email: 'alice@northwind.example', password: PASSWORD_A, name: 'Alice', organization_name: 'Northwind HVAC' });
  const orgA = aliceSession.organizations[0].id;
  assert.strictEqual(aliceSession.user.email, 'alice@northwind.example');
  assert.strictEqual(aliceSession.organizations.length, 1, 'registration creates exactly one organization');
  assert.strictEqual(aliceSession.organizations[0].role, 'owner');
  assert.ok(alice.jar.atb_session, 'registration sets a session cookie');

  const bob = client();
  const bobSession = await bob.register({ email: 'bob@southwind.example', password: PASSWORD_B, name: 'Bob', organization_name: 'Southwind Heating' });
  const orgB = bobSession.organizations[0].id;
  assert.notStrictEqual(orgA, orgB);

  assert.strictEqual((await client().call('POST', 'auth/register', { email: 'alice@northwind.example', password: PASSWORD_A })).status, 409, 'emails are unique');
  assert.strictEqual((await client().call('POST', 'auth/register', { email: 'ALICE@northwind.example', password: PASSWORD_A })).status, 409, 'email uniqueness is case-insensitive');
  assert.strictEqual((await client().call('POST', 'auth/register', { email: 'short@example.com', password: 'short' })).status, 400, 'weak passwords are rejected');
  assert.strictEqual((await client().call('POST', 'auth/register', { email: 'nope', password: PASSWORD_A })).status, 400, 'the email must look like an email');
  assert.strictEqual((await client().call('POST', 'auth/register', { email: 'x@example.com', password: PASSWORD_A }, { env: { ALLOW_SIGNUP: 'false' } })).status, 403, 'signup can be disabled per environment');

  /* --- Seed a rich account into org A so there is data to isolate ------ */
  await alice.ok('POST', 'demo/seed', { reset: false });
  const demoOrg = 'org_nwha';
  const aliceOrgs = (await alice.ok('GET', 'auth/session')).organizations.map(o => o.id);
  assert.deepStrictEqual(aliceOrgs.sort(), [demoOrg, orgA].sort(), 'seeding from a session also grants that session access');

  /* --- Authenticated access to your own organization ------------------- */
  const ownAccount = await alice.ok('GET', `bootstrap?organization_id=${demoOrg}`);
  assert.strictEqual(ownAccount.organization.id, demoOrg);
  assert.strictEqual(ownAccount.properties.length, 52, 'the owner sees the full account');
  assert.ok(ownAccount.opportunities.length > 0);

  const impliedAccount = await alice.ok('GET', 'bootstrap');
  assert.ok(impliedAccount.organization.id, 'bootstrap without an organization_id resolves from the session');
  assert.ok(aliceOrgs.includes(impliedAccount.organization.id));

  /* --- Unauthenticated dashboard requests are 401 ---------------------- */
  const anonymous = client();
  for (const [method, route, body] of [
    ['GET', 'bootstrap', undefined],
    ['GET', `bootstrap?organization_id=${demoOrg}`, undefined],
    ['GET', 'organizations', undefined],
    ['GET', 'auth/session', undefined],
    ['GET', `homes?organization_id=${demoOrg}`, undefined],
    ['GET', `opportunities?organization_id=${demoOrg}`, undefined],
    ['POST', 'opportunities/recalculate', { organization_id: demoOrg }],
    ['POST', 'jobs/import', { organization_id: demoOrg, rows: [] }],
    ['PATCH', `organizations/${demoOrg}`, { name: 'Hijacked' }],
    ['POST', 'visibility/snapshots', { organization_id: demoOrg }],
    ['POST', 'visibility/queries', { organization_id: demoOrg, query_text: 'x' }]
  ]) {
    const result = await anonymous.call(method, route, body);
    assert.strictEqual(result.status, 401, `${method} /api/${route} must require authentication`);
  }

  /* --- A signed-in user cannot reach another organization -------------- */
  assert.strictEqual((await bob.call('GET', `bootstrap?organization_id=${demoOrg}`)).status, 403, 'reading another organization is forbidden');
  assert.strictEqual((await bob.call('GET', `bootstrap?organization_id=${orgA}`)).status, 403);
  assert.strictEqual((await bob.call('GET', `homes?organization_id=${demoOrg}`)).status, 403);
  assert.strictEqual((await bob.call('GET', `opportunities?organization_id=${demoOrg}`)).status, 403);
  assert.strictEqual((await bob.call('GET', 'bootstrap?slug=northwest-heating-air')).status, 403, 'slug lookups are authorized too');

  const bobOrganizations = await bob.ok('GET', 'organizations');
  assert.deepStrictEqual(bobOrganizations.map(o => o.id), [orgB], 'the organization list is scoped to the session');

  /* --- User A cannot mutate organization B ----------------------------- */
  assert.strictEqual((await bob.call('PATCH', `organizations/${demoOrg}`, { name: 'Hijacked' })).status, 403);
  assert.strictEqual((await bob.call('POST', 'visibility/snapshots', { organization_id: demoOrg, ai_mention_rate: 99 })).status, 403);
  assert.strictEqual((await bob.call('POST', 'visibility/queries', { organization_id: demoOrg, query_text: 'injected' })).status, 403);
  assert.strictEqual((await alice.call('PATCH', `organizations/${orgB}`, { name: 'Hijacked' })).status, 403);
  assert.strictEqual((await alice.ok('GET', `bootstrap?organization_id=${demoOrg}`)).organization.name, 'Northwest Heating & Air', 'the rejected writes changed nothing');

  /* --- CSV import cannot target another organization ------------------- */
  const importRows = [{ first_name: 'Mallory', last_name: 'Cross', address: '1 Intruder Way', city: 'Bellingham', state: 'WA', zip: '98225', job_date: '2026-08-01', job_type: 'Furnace Tune-Up', amount: '199' }];
  assert.strictEqual((await bob.call('POST', 'jobs/import', { organization_id: demoOrg, rows: importRows })).status, 403);
  assert.strictEqual((await alice.call('POST', 'jobs/import', { organization_id: orgB, rows: importRows })).status, 403);
  assert.strictEqual((await alice.ok('GET', `bootstrap?organization_id=${demoOrg}`)).properties.length, 52, 'the rejected import wrote nothing');
  assert.strictEqual((await bob.ok('GET', `bootstrap?organization_id=${orgB}`)).properties.length, 0, 'org B is still empty');

  /* --- Opportunity recalculation cannot target another organization ---- */
  assert.strictEqual((await bob.call('POST', 'opportunities/recalculate', { organization_id: demoOrg })).status, 403);
  assert.strictEqual((await bob.call('POST', 'opportunities/recalculate', { organization_id: orgA })).status, 403);
  assert.strictEqual((await bob.ok('POST', 'opportunities/recalculate', { organization_id: orgB })).open_opportunities, 0, 'B can still run its own engine');

  /* --- Cross-tenant resource ids read as 404, never as another tenant's data --- */
  const target = (await alice.ok('GET', `bootstrap?organization_id=${demoOrg}`)).opportunities.find(o => o.status === 'open');
  const property = (await alice.ok('GET', `bootstrap?organization_id=${demoOrg}`)).properties[0];
  const rule = (await alice.ok('GET', `bootstrap?organization_id=${demoOrg}`)).automationRules[0];
  for (const [method, route, body] of [
    ['POST', `opportunities/${target.id}/book`, {}],
    ['POST', `opportunities/${target.id}/dismiss`, {}],
    ['GET', `homes/${property.id}`, undefined],
    ['POST', `homes/${property.id}/home-record`, {}],
    ['PATCH', `automation-rules/${rule.id}`, { enabled: false }]
  ]) {
    const result = await bob.call(method, route, body);
    assert.strictEqual(result.status, 404, `${method} /api/${route} must not expose another tenant's record`);
  }
  assert.strictEqual((await alice.ok('GET', `bootstrap?organization_id=${demoOrg}`)).opportunities.find(o => o.id === target.id).status, 'open', 'the rejected booking did not fire');

  /* --- Home Records: scoped to one property, and never a dashboard key -- */
  const account = await alice.ok('GET', `bootstrap?organization_id=${demoOrg}`);
  const access = account.homeRecordAccess.find(a => a.status !== 'claimed');
  const homeowner = client();
  const record = await homeowner.ok('GET', `home-record/${encodeURIComponent(access.token)}`);

  assert.strictEqual(record.property.id, access.property_id, 'the token resolves to exactly one property');
  assert.ok(record.assets.every(a => !('property_id' in a) && !('organization_id' in a)), 'assets carry no tenant identifiers');
  assert.ok(record.serviceEvents.every(e => !('organization_id' in e) && !('homeowner_id' in e)), 'service history carries no tenant identifiers');
  assert.ok(record.opportunities.every(o => o.id && !('dedupe_key' in o) && !('organization_id' in o) && !('actual_value' in o)), 'opportunities are projected, not dumped');
  assert.strictEqual(record.organization.average_job_value, undefined, 'contractor pricing inputs are not homeowner-facing');
  assert.strictEqual(record.organization.monitoring_fee, undefined, 'contractor billing is not homeowner-facing');
  assert.strictEqual(record.access.token, undefined, 'the response does not echo the capability token');
  assert.strictEqual(record.homeowner.contact_status, undefined, 'marketing-consent state stays internal');

  const otherProperties = account.properties.filter(p => p.id !== access.property_id).map(p => p.id);
  const leaked = JSON.stringify(record);
  assert.ok(otherProperties.every(id => !leaked.includes(id)), 'no other property appears anywhere in the payload');

  // The Home Record token must be worthless against the dashboard.
  const impostor = client({ atb_session: access.token });
  assert.strictEqual((await impostor.call('GET', `bootstrap?organization_id=${demoOrg}`)).status, 401, 'a Home Record token is not a session');
  assert.strictEqual((await impostor.call('GET', 'auth/session')).status, 401);
  assert.strictEqual((await impostor.call('POST', 'jobs/import', { organization_id: demoOrg, rows: importRows })).status, 401);

  /* --- Invalid, revoked and expired Home Record tokens are rejected ----- */
  assert.strictEqual((await homeowner.call('GET', 'home-record/not-a-real-token')).status, 404);
  assert.strictEqual((await homeowner.call('POST', 'home-record/not-a-real-token/claim', {})).status, 404);
  assert.strictEqual((await homeowner.call('POST', 'home-record/not-a-real-token/book', {})).status, 404);

  const expiring = account.homeRecordAccess.find(a => a.token !== access.token);
  sqlite.exec(`UPDATE home_record_access SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = '${expiring.token}'`);
  assert.strictEqual((await homeowner.call('GET', `home-record/${encodeURIComponent(expiring.token)}`)).status, 404, 'an expired token is rejected');
  assert.strictEqual((await homeowner.call('POST', `home-record/${encodeURIComponent(expiring.token)}/claim`, {})).status, 404, 'an expired token cannot claim');
  assert.strictEqual((await homeowner.call('POST', `home-record/${encodeURIComponent(expiring.token)}/book`, {})).status, 404, 'an expired token cannot book');

  const revoked = account.homeRecordAccess.find(a => a.token !== access.token && a.token !== expiring.token);
  sqlite.exec(`UPDATE home_record_access SET status = 'revoked' WHERE token = '${revoked.token}'`);
  assert.strictEqual((await homeowner.call('GET', `home-record/${encodeURIComponent(revoked.token)}`)).status, 404, 'a revoked token is rejected');

  // A homeowner cannot book against a different property by supplying its id.
  const foreignOpportunity = account.opportunities.find(o => o.property_id !== access.property_id && o.status === 'open');
  const booked = await homeowner.ok('POST', `home-record/${encodeURIComponent(access.token)}/book`, { opportunity_id: foreignOpportunity.id });
  assert.notStrictEqual(booked.opportunity_id, foreignOpportunity.id, 'a foreign opportunity id is not honoured');
  assert.strictEqual((await alice.ok('GET', `bootstrap?organization_id=${demoOrg}`)).opportunities.find(o => o.id === foreignOpportunity.id).status, 'open', 'the foreign opportunity was untouched');

  /* --- Login, bad credentials and account enumeration ------------------ */
  const returning = client();
  assert.strictEqual((await returning.call('POST', 'auth/login', { email: 'alice@northwind.example', password: 'wrong-password-here' })).status, 401);
  const unknown = await returning.call('POST', 'auth/login', { email: 'nobody@example.com', password: 'wrong-password-here' });
  assert.strictEqual(unknown.status, 401);
  assert.strictEqual(unknown.payload.error, 'Invalid email or password', 'unknown accounts and wrong passwords are indistinguishable');
  assert.ok(!returning.jar.atb_session, 'a failed login sets no cookie');

  await returning.login('ALICE@northwind.example', PASSWORD_A);
  assert.ok(returning.jar.atb_session, 'login is case-insensitive on email and sets a session');
  assert.strictEqual((await returning.ok('GET', `bootstrap?organization_id=${demoOrg}`)).properties.length, 52);

  /* --- Logout invalidates the session ---------------------------------- */
  const cookieBeforeLogout = returning.jar.atb_session;
  await returning.ok('POST', 'auth/logout', {});
  assert.ok(!returning.jar.atb_session, 'logout clears the cookie');
  assert.strictEqual((await returning.call('GET', `bootstrap?organization_id=${demoOrg}`)).status, 401, 'the signed-out client is rejected');

  // Replaying the exact cookie value must fail: the server-side row is gone.
  const replay = client({ atb_session: cookieBeforeLogout });
  assert.strictEqual((await replay.call('GET', `bootstrap?organization_id=${demoOrg}`)).status, 401, 'a logged-out session token cannot be replayed');
  assert.strictEqual((await replay.call('GET', 'auth/session')).status, 401);

  /* --- Expired sessions are rejected and cleaned up -------------------- */
  const expiringSession = client();
  await expiringSession.login('alice@northwind.example', PASSWORD_A);
  sqlite.exec("UPDATE sessions SET expires_at = '2020-01-01T00:00:00.000Z'");
  const sessionsBeforeExpiry = sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
  assert.strictEqual((await expiringSession.call('GET', 'auth/session')).status, 401, 'expired sessions are rejected');
  assert.strictEqual((await expiringSession.call('GET', `bootstrap?organization_id=${demoOrg}`)).status, 401, 'an expired session reads nothing');
  assert.strictEqual(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, sessionsBeforeExpiry - 1,
    'the expired session that was presented is deleted on sight');
  sqlite.exec('DELETE FROM sessions');

  /* --- Sessions are stored hashed, and passwords are never stored raw --- */
  const freshLogin = client();
  await freshLogin.login('alice@northwind.example', PASSWORD_A);
  const storedSession = sqlite.prepare('SELECT token_hash FROM sessions').get();
  assert.ok(storedSession.token_hash && storedSession.token_hash !== freshLogin.jar.atb_session, 'the raw session token is not stored');
  assert.strictEqual(storedSession.token_hash.length, 64, 'sessions are stored as a SHA-256 hex digest');
  const storedUser = sqlite.prepare('SELECT password_hash FROM users WHERE email_normalized = ?').get('alice@northwind.example');
  assert.ok(storedUser.password_hash.startsWith('pbkdf2$'), 'passwords are stored as a salted PBKDF2 digest');
  assert.ok(!storedUser.password_hash.includes(PASSWORD_A), 'the password is not recoverable from the row');
  const [, iterations] = storedUser.password_hash.split('$');
  assert.ok(Number(iterations) >= 100000, 'the stored iteration count is at the platform ceiling');

  /* --- Session cookie hardening ---------------------------------------- */
  const cookieClient = client();
  const loginResponse = await cookieClient.call('POST', 'auth/login', { email: 'alice@northwind.example', password: PASSWORD_A });
  const setCookie = loginResponse.headers.get('set-cookie');
  assert.ok(/HttpOnly/i.test(setCookie), 'the session cookie is HttpOnly');
  assert.ok(/SameSite=Strict/i.test(setCookie), 'the session cookie is SameSite=Strict');
  assert.ok(/Path=\//.test(setCookie), 'the session cookie is scoped to the site root');

  /* --- Cross-origin state change is rejected --------------------------- */
  const csrf = await freshLogin.call('POST', 'opportunities/recalculate', { organization_id: demoOrg }, { headers: { origin: 'https://evil.example' } });
  assert.strictEqual(csrf.status, 403, 'a cross-origin mutation is rejected even with a valid cookie');
  const sameOrigin = await freshLogin.call('POST', 'opportunities/recalculate', { organization_id: demoOrg }, { headers: { origin: 'http://localhost' } });
  assert.strictEqual(sameOrigin.status, 200, 'a same-origin mutation still works');

  /* --- Demo seeding stays environment-gated ---------------------------- */
  assert.strictEqual((await alice.call('POST', 'demo/seed', {}, { env: { ALLOW_DEMO_SEED: 'false' } })).status, 403);
  assert.strictEqual((await alice.call('POST', 'demo/seed', {}, { env: { ALLOW_DEMO_SEED: undefined } })).status, 403, 'seeding is off unless explicitly enabled');

  /* --- Explicit membership is what grants access ------------------------ */
  sqlite.exec(`DELETE FROM organization_members WHERE organization_id = '${demoOrg}' AND user_id = (SELECT id FROM users WHERE email_normalized = 'alice@northwind.example')`);
  assert.strictEqual((await freshLogin.call('GET', `bootstrap?organization_id=${demoOrg}`)).status, 403, 'removing the membership immediately removes access');
  assert.deepStrictEqual((await freshLogin.ok('GET', 'organizations')).map(o => o.id), [orgA], 'the organization list follows membership');

  h.close();
  console.log('asktobooked auth and tenant isolation tests passed');
}

main().catch(error => { console.error(error); process.exit(1); });
