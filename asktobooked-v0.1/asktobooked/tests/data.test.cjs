/**
 * Data adapter tests.
 *
 * These prove the contract the dashboard depends on: when the API answers, the
 * API is the source of truth, mutations go over HTTP, and the rendered state is
 * always a re-read of what the backend persisted rather than an optimistic
 * local edit. Browser storage is only allowed to matter when the API is gone.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { module: { exports: {} }, exports: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8'), sandbox, { filename: 'core.js' });
const C = sandbox.module.exports;
sandbox.module = { exports: {} };
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8'), sandbox, { filename: 'data.js' });
const D = sandbox.module.exports;

const clone = value => JSON.parse(JSON.stringify(value));
const ORG = 'org_test';

function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); }
  };
}

/** An in-memory stand-in for the D1-backed Pages Function API. */
function createFakeBackend() {
  const backend = {
    calls: [],
    offline: false,
    failNext: null,
    missingOrganization: false,
    signedIn: true,
    data: null
  };

  backend.reset = () => {
    backend.data = {
      organization: { id: ORG, name: 'Northwest Heating & Air', slug: 'northwest-heating-air', industry: 'HVAC', city: 'Bellingham', state: 'WA', service_area: 'Whatcom County', phone: '(360) 555-0188', email: '', website: '', booking_url: '', average_job_value: '4650', monitoring_fee: '499' },
      homeowners: [{ id: 'ho_1', organization_id: ORG, first_name: 'Dana', last_name: 'Reed', email: 'dana@example.com', phone: '(360) 555-1000', contact_status: 'consented' }],
      properties: [{ id: 'prop_1', organization_id: ORG, homeowner_id: 'ho_1', address_line_1: '120 Cedar Ln', city: 'Bellingham', state: 'WA', postal_code: '98225', normalized_address: '120cedarlnbellinghamwa98225' }],
      assets: [{ id: 'asset_1', organization_id: ORG, property_id: 'prop_1', category: 'Heat Pump', manufacturer: 'Trane', model: 'XR16', install_date: '2010-04-01', estimated_lifespan_years: 15 }],
      serviceEvents: [{ id: 'evt_1', organization_id: ORG, property_id: 'prop_1', homeowner_id: 'ho_1', asset_id: 'asset_1', type: 'installation', service_date: '2010-04-01', description: 'Heat pump installation', amount: 9200, status: 'completed' }],
      opportunities: [{ id: 'opp_1', dedupe_key: 'maintenance_due:prop_1:asset_1:', organization_id: ORG, property_id: 'prop_1', homeowner_id: 'ho_1', asset_id: 'asset_1', type: 'maintenance_due', title: 'Annual maintenance due', reason: 'No recorded maintenance in 330+ days.', estimated_value: '249', actual_value: null, due_date: '2026-08-01', confidence: 'high', status: 'open' }],
      interactions: [],
      bookings: [],
      homeRecordAccess: [{ id: 'acc_1', property_id: 'prop_1', homeowner_id: 'ho_1', token: 'demo-token', status: 'invited' }],
      visibility: {
        snapshots: [{ id: 'vis_1', snapshot_date: '2026-08-01', ai_mention_rate: 58, local_visibility: 71, website_conversion: 4.1, qualified_leads: 34, booked_jobs: 12, new_reviews: 7, response_minutes: 18 }],
        queries: [{ id: 'q_1', query_text: 'best heat pump installer', platform: 'ChatGPT', status: 'Missed', competitor: 'Barron Heating' }]
      },
      automationRules: [{ id: 'rule_1', organization_id: ORG, name: 'Maintenance due', event_key: 'asset.service_due', description: 'Fires at 330 days.', channel: 'Opportunity', enabled: 1 }]
    };
  };
  backend.reset();

  const ok = data => ({ ok: true, status: 200, json: async () => ({ ok: true, data: clone(data) }) });
  const err = (status, message) => ({ ok: false, status, json: async () => ({ ok: false, error: message }) });

  backend.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const [rawPath, search] = String(url).replace(/^\/api\/?/, '').split('?');
    const route = rawPath.replace(/\/$/, '');
    const body = init.body ? JSON.parse(init.body) : {};
    backend.calls.push({ method, route, search: search || '', body });

    if (backend.offline) throw new Error('fetch failed');
    if (backend.failNext) { const failure = backend.failNext; backend.failNext = null; return err(failure.status, failure.error); }

    const data = backend.data;
    // Every dashboard route is behind a session, so the adapter establishes one
    // before it reads anything.
    if (!backend.signedIn && !/^auth\//.test(route)) return err(401, 'Authentication required');
    if (method === 'GET' && route === 'auth/session') {
      if (!backend.signedIn) return err(401, 'Authentication required');
      return ok({ user: { id: 'user_1', email: 'owner@example.com', name: 'Owner' }, organizations: [{ id: ORG, name: data.organization.name, role: 'owner' }] });
    }
    if (method === 'POST' && route === 'auth/logout') { backend.signedIn = false; return ok({ signed_out: true }); }
    if (method === 'GET' && route === 'organizations') return ok(backend.missingOrganization ? [] : [{ id: ORG, name: data.organization.name }]);
    if (method === 'GET' && route === 'bootstrap') {
      if (backend.missingOrganization) return err(404, 'Organization not found');
      return ok(data);
    }
    if (method === 'PATCH' && route === `organizations/${ORG}`) { Object.assign(data.organization, body); return ok(data.organization); }
    if (method === 'POST' && route === 'opportunities/recalculate') {
      data.opportunities.push({ id: 'opp_generated', dedupe_key: 'dormant_relationship:prop_1::evt_1', organization_id: ORG, property_id: 'prop_1', homeowner_id: 'ho_1', type: 'dormant_relationship', title: 'Dormant homeowner relationship', reason: 'No completed service in 24 months.', estimated_value: 1650, actual_value: null, due_date: '2026-08-30', confidence: 'medium', status: 'open' });
      return ok({ open_opportunities: data.opportunities.filter(o => o.status === 'open').length });
    }
    if (method === 'POST' && route === 'jobs/import') {
      body.rows.forEach((row, index) => {
        data.properties.push({ id: `prop_import_${index}`, organization_id: ORG, homeowner_id: 'ho_1', address_line_1: row.address, city: row.city, state: row.state, postal_code: row.zip, normalized_address: `imported${index}` });
      });
      return ok({ rows_received: body.rows.length, jobs_imported: body.rows.length, rows_skipped: 0, new_homes: body.rows.length, new_homeowners: 0, unique_homes: data.properties.length, unique_homeowners: data.homeowners.length, open_opportunities: 1, estimated_opportunity_value: 249 });
    }
    if (method === 'POST' && /^opportunities\/[^/]+\/book$/.test(route)) {
      const opportunity = data.opportunities.find(o => o.id === route.split('/')[1]);
      if (!opportunity) return err(404, 'Opportunity not found');
      // Deliberately not "booked": the client must render whatever the server stored.
      opportunity.status = 'won';
      opportunity.actual_value = body.actual_value === null || body.actual_value === undefined ? opportunity.estimated_value : body.actual_value;
      data.bookings.push({ id: 'booking_1', organization_id: ORG, property_id: opportunity.property_id, opportunity_id: opportunity.id, status: 'requested', estimated_value: opportunity.estimated_value });
      return ok({ booking_id: 'booking_1', opportunity_id: opportunity.id, status: 'booked' });
    }
    if (method === 'POST' && /^opportunities\/[^/]+\/dismiss$/.test(route)) {
      const opportunity = data.opportunities.find(o => o.id === route.split('/')[1]);
      if (!opportunity) return err(404, 'Opportunity not found');
      opportunity.status = 'dismissed';
      return ok({ opportunity_id: opportunity.id, status: 'dismissed' });
    }
    if (method === 'PATCH' && /^automation-rules\//.test(route)) {
      const rule = data.automationRules.find(r => r.id === route.split('/')[1]);
      rule.enabled = body.enabled ? 1 : 0;
      return ok(rule);
    }
    if (method === 'POST' && route === 'visibility/snapshots') { const row = { id: 'vis_2', ...body }; data.visibility.snapshots.push(row); return ok(row); }
    if (method === 'POST' && route === 'visibility/queries') { const row = { id: 'q_2', ...body }; data.visibility.queries.push(row); return ok(row); }
    if (method === 'POST' && /^homes\/[^/]+\/home-record$/.test(route)) {
      const propertyId = route.split('/')[1];
      const row = { id: `acc_${propertyId}`, property_id: propertyId, homeowner_id: 'ho_1', token: `token-${propertyId}`, status: 'invited' };
      data.homeRecordAccess.push(row);
      return ok(row);
    }
    if (method === 'POST' && route === 'demo/seed') { backend.missingOrganization = false; return ok({ organization_id: ORG, seeded: true, unique_homes: 52, open_opportunities: 90 }); }
    if (method === 'GET' && /^home-record\/[^/]+$/.test(route)) {
      const access = data.homeRecordAccess.find(a => a.token === decodeURIComponent(route.split('/')[1]));
      if (!access) return err(404, 'Home Record not found');
      return ok({ access, organization: data.organization, homeowner: data.homeowners[0], property: data.properties[0], assets: data.assets, serviceEvents: data.serviceEvents, opportunities: data.opportunities.filter(o => o.status === 'open') });
    }
    if (method === 'POST' && /^home-record\/[^/]+\/claim$/.test(route)) {
      const access = data.homeRecordAccess.find(a => a.token === decodeURIComponent(route.split('/')[1]));
      access.status = 'claimed';
      return ok({ property_id: access.property_id, status: 'claimed' });
    }
    if (method === 'POST' && /^home-record\/[^/]+\/book$/.test(route)) {
      const opportunity = data.opportunities.find(o => o.id === body.opportunity_id) || data.opportunities[0];
      opportunity.status = 'booked';
      return ok({ booking_id: 'booking_hr', opportunity_id: opportunity.id });
    }
    return err(404, `Route not found: ${method} ${route}`);
  };

  backend.lastCall = () => backend.calls[backend.calls.length - 1];
  backend.calledWith = (method, route) => backend.calls.some(call => call.method === method && call.route === route);
  return backend;
}

function createStore(backend, storage, overrides = {}) {
  return D.createStore({ core: C, storage, organizationId: ORG, fetch: backend.fetch, ...overrides });
}

async function main() {
  /* --- Row mapping ---------------------------------------------------- */
  {
    const backend = createFakeBackend();
    const state = D.stateFromBootstrap(clone(backend.data), C);
    assert.strictEqual(state.automationRules[0].event, 'asset.service_due', 'event_key maps to the client rule "event" field');
    assert.strictEqual(state.automationRules[0].enabled, true, 'integer enabled maps to a boolean');
    assert.strictEqual(state.visibility.snapshots[0].date, '2026-08-01', 'snapshot_date maps to date');
    assert.strictEqual(state.visibility.snapshots[0].ai, 58, 'ai_mention_rate maps to ai');
    assert.strictEqual(state.visibility.queries[0].query, 'best heat pump installer', 'query_text maps to query');
    assert.strictEqual(state.organization.average_job_value, 4650, 'organization numerics are coerced');
    assert.strictEqual(state.opportunities[0].estimated_value, 249, 'opportunity values are coerced to numbers');
    assert.strictEqual(state.meta.mode, 'remote');

    const row = D.snapshotToRow({ date: '2026-09-01', ai: 61, local: 74, conv: 4.8, leads: 40, booked: 16, reviews: 5, response: 11 });
    assert.strictEqual(row.snapshot_date, '2026-09-01');
    assert.strictEqual(row.qualified_leads, 40);
    assert.strictEqual(D.queryToRow({ query: 'hvac near me' }).query_text, 'hvac near me');
  }

  /* --- The API wins over anything already in browser storage ---------- */
  const backend = createFakeBackend();
  const localWorkspace = C.makeDemoState();
  const storage = createFakeStorage({ [C.STORAGE_KEY]: JSON.stringify(localWorkspace) });
  const store = createStore(backend, storage);

  await store.load();
  assert.strictEqual(store.mode, 'remote', 'a healthy API puts the store in remote mode');
  assert.strictEqual(store.status.error, null);
  assert.strictEqual(store.state.properties.length, 1, 'remote state replaces the 52-home local demo workspace');
  assert.strictEqual(store.state.organization.name, 'Northwest Heating & Air');
  assert.ok(backend.calledWith('GET', 'bootstrap'), 'load() reads GET /api/bootstrap');
  assert.ok(backend.calledWith('GET', 'auth/session'), 'load() establishes who the caller is before reading an account');
  assert.strictEqual(backend.calls.find(call => call.route === 'bootstrap').search, `organization_id=${ORG}`, 'bootstrap is scoped by organization_id');
  assert.strictEqual(store.user.email, 'owner@example.com', 'the signed-in user is exposed for the UI');
  assert.deepStrictEqual(store.organizations.map(o => o.id), [ORG], 'the organization list comes from the session');
  assert.strictEqual(storage.getItem(C.STORAGE_KEY), JSON.stringify(localWorkspace), 'remote mode never overwrites the local workspace');
  assert.ok(storage.getItem(`${D.CACHE_PREFIX}${ORG}`), 'a synced snapshot is cached for offline use');

  /* --- Mutations persist through the API and re-read the result ------- */
  await store.bookOpportunity('opp_1');
  assert.ok(backend.calledWith('POST', 'opportunities/opp_1/book'), 'booking calls the API');
  assert.strictEqual(store.state.opportunities.find(o => o.id === 'opp_1').status, 'won', 'UI shows the persisted server status, not an optimistic local one');
  assert.strictEqual(store.state.bookings.length, 1, 'the persisted booking is visible after the refresh');
  assert.strictEqual(C.dashboardMetrics(store.state).recoveredRevenue, 249, 'recovered revenue derives from persisted state');

  await store.recalculateOpportunities();
  assert.ok(backend.calledWith('POST', 'opportunities/recalculate'), 'recalculation is delegated to the engine endpoint');
  assert.strictEqual(store.state.opportunities.length, 2, 'generated opportunities come back from the server');

  const importResult = await store.importCSV('first_name,last_name,email,address,city,state,zip,job_date,job_type,amount\nTest,Owner,test@example.com,999 New St,Bellingham,WA,98225,2026-01-02,Heat Pump Installation,10000');
  const importCall = backend.calls.find(call => call.route === 'jobs/import');
  assert.strictEqual(importCall.body.rows.length, 1, 'the CSV is parsed client-side and posted as rows');
  assert.strictEqual(importCall.body.rows[0].address, '999 New St');
  assert.strictEqual(importCall.body.organization_id, ORG);
  assert.strictEqual(importResult.jobs_imported, 1);
  assert.strictEqual(store.state.properties.length, 2, 'imported homes appear from persisted state');

  await store.dismissOpportunity('opp_generated');
  assert.strictEqual(store.state.opportunities.find(o => o.id === 'opp_generated').status, 'dismissed');

  await store.updateOrganization({ name: 'Northwest Heating and Air Co', average_job_value: 5100 });
  assert.strictEqual(store.state.organization.name, 'Northwest Heating and Air Co', 'settings persist through PATCH /api/organizations/:id');
  assert.strictEqual(store.state.organization.average_job_value, 5100);

  await store.setAutomationRuleEnabled('rule_1', false);
  assert.strictEqual(store.state.automationRules[0].enabled, false, 'automation toggles persist and map back to a boolean');

  await store.addVisibilitySnapshot({ date: '2026-09-01', ai: 61, local: 74, conv: 4.8, leads: 40, booked: 16, reviews: 5, response: 11 });
  const snapshotCall = backend.calls.find(call => call.route === 'visibility/snapshots');
  assert.strictEqual(snapshotCall.body.snapshot_date, '2026-09-01', 'client field names are mapped to column names');
  assert.strictEqual(store.state.visibility.snapshots.length, 2);

  await store.addVisibilityQuery({ query: 'heat pump rebate Bellingham', platform: 'Perplexity', status: 'Missed', competitor: '' });
  assert.strictEqual(store.state.visibility.queries.length, 2);

  const access = await store.ensureHomeRecord('prop_import_0');
  assert.ok(backend.calledWith('POST', 'homes/prop_import_0/home-record'), 'missing Home Record access is created server-side');
  assert.strictEqual(access.property_id, 'prop_import_0');
  const callsBefore = backend.calls.length;
  await store.ensureHomeRecord('prop_import_0');
  assert.strictEqual(backend.calls.length, callsBefore, 'an existing Home Record is not recreated');

  /* --- A second browser session sees the same persisted account ------- */
  const secondSession = createStore(backend, createFakeStorage());
  await secondSession.load();
  assert.strictEqual(secondSession.state.organization.name, 'Northwest Heating and Air Co', 'a fresh session reproduces persisted state');
  assert.strictEqual(secondSession.state.properties.length, 2);
  assert.strictEqual(secondSession.state.opportunities.find(o => o.id === 'opp_1').status, 'won');

  /* --- API errors are surfaced, not silently swallowed ---------------- */
  backend.failNext = { status: 500, error: 'API request failed' };
  await store.load();
  assert.strictEqual(store.mode, 'remote', 'a server-side error does not silently demote to local data');
  assert.ok(String(store.status.error).includes('API request failed'), 'the error is exposed on status');

  backend.failNext = { status: 400, error: 'organization_id is required' };
  await assert.rejects(() => store.updateOrganization({ name: 'Nope' }), /organization_id is required/, 'failed mutations reject so the UI can report them');

  /* --- Offline shows the last synced snapshot, read-only ------------- */
  await store.load();
  const localWorkspaceBeforeOffline = storage.getItem(C.STORAGE_KEY);
  backend.offline = true;
  await store.load();
  assert.strictEqual(store.mode, 'local', 'an unreachable backend falls back to local data');
  assert.strictEqual(store.status.readOnly, true, 'a cached snapshot of a real account is read-only');
  assert.ok(String(store.status.warning).includes('unreachable'), 'the fallback is announced');
  assert.strictEqual(store.status.error, null);
  assert.strictEqual(store.state.properties.length, 2, 'the cached snapshot is used when one exists');
  assert.strictEqual(store.state.opportunities.length, 2, 'a cached snapshot is not re-run through the client engine');
  await assert.rejects(() => store.dismissOpportunity('opp_1'), /read-only/, 'offline writes against a real account are refused, not silently dropped');
  assert.strictEqual(storage.getItem(C.STORAGE_KEY), localWorkspaceBeforeOffline, 'a read-only snapshot never overwrites the local workspace');
  backend.offline = false;

  /* --- No cache and no backend: an interactive demo workspace -------- */
  {
    const coldBackend = createFakeBackend();
    coldBackend.offline = true;
    const coldStorage = createFakeStorage();
    const coldStore = createStore(coldBackend, coldStorage);
    await coldStore.load();
    assert.strictEqual(coldStore.mode, 'local');
    assert.strictEqual(coldStore.status.readOnly, false, 'the demo workspace stays interactive');
    assert.ok(coldStore.state.properties.length >= 50, 'the demo workspace is the last-resort fallback');
    const open = coldStore.state.opportunities.find(o => o.status === 'open');
    await coldStore.bookOpportunity(open.id);
    assert.ok(['booked','won'].includes(coldStore.state.opportunities.find(o => o.id === open.id).status), 'demo bookings work with no backend');
    assert.ok(coldStorage.getItem(C.STORAGE_KEY), 'demo edits are kept in the browser workspace');
  }

  /* --- Unknown organization surfaces a seedable empty state ---------- */
  {
    const emptyBackend = createFakeBackend();
    emptyBackend.missingOrganization = true;
    const emptyStore = createStore(emptyBackend, createFakeStorage());
    await emptyStore.load();
    assert.strictEqual(emptyStore.status.needsSeed, true, 'a missing organization is an empty state, not an error');
    assert.strictEqual(emptyStore.mode, 'remote');
    assert.strictEqual(emptyStore.state.properties.length, 0);

    await emptyStore.seedDemoOrganization({ reset: false });
    assert.ok(emptyBackend.calledWith('POST', 'demo/seed'), 'seeding is a server-side operation');
    assert.strictEqual(emptyStore.status.needsSeed, false);
    assert.strictEqual(emptyStore.state.organization.name, 'Northwest Heating & Air', 'the seeded account is loaded from the API');
  }

  /* --- No session: sign-in is required, never a silent demo fallback -- */
  {
    const lockedBackend = createFakeBackend();
    lockedBackend.signedIn = false;
    const lockedStorage = createFakeStorage({ [C.STORAGE_KEY]: JSON.stringify(C.makeDemoState()) });
    const lockedStore = createStore(lockedBackend, lockedStorage);
    await lockedStore.load();
    assert.strictEqual(lockedStore.status.unauthenticated, true, 'a 401 asks the user to sign in');
    assert.strictEqual(lockedStore.mode, 'remote', 'a 401 must not be mistaken for an offline fallback');
    assert.strictEqual(lockedStore.status.readOnly, false);
    assert.strictEqual(lockedStore.state.properties.length, 0, 'no account data is shown without a session');
    assert.ok(!lockedBackend.calledWith('GET', 'bootstrap'), 'no account read is attempted without a session');
  }

  /* --- A session that expires mid-flight stops the write -------------- */
  {
    const expiringBackend = createFakeBackend();
    const expiringStore = createStore(expiringBackend, createFakeStorage());
    await expiringStore.load();
    assert.strictEqual(expiringStore.status.unauthenticated, false);

    expiringBackend.failNext = { status: 401, error: 'Authentication required' };
    await assert.rejects(() => expiringStore.recalculateOpportunities(), /Authentication required/, 'an expired session rejects the mutation');
    assert.strictEqual(expiringStore.status.unauthenticated, true, 'the store switches to a signed-out state');
    assert.ok(String(expiringStore.status.error).includes('session has expired'), 'the user is told why the change did not save');
  }

  /* --- Signing out clears the session and the cached snapshot --------- */
  {
    const signOutBackend = createFakeBackend();
    const signOutStorage = createFakeStorage();
    const signOutStore = createStore(signOutBackend, signOutStorage);
    await signOutStore.load();
    assert.ok(signOutStorage.getItem(`${D.CACHE_PREFIX}${ORG}`), 'a snapshot was cached while signed in');

    await signOutStore.signOut();
    assert.ok(signOutBackend.calledWith('POST', 'auth/logout'), 'signing out invalidates the session server-side');
    assert.strictEqual(signOutStore.status.unauthenticated, true);
    assert.strictEqual(signOutStore.user, null, 'the identity is dropped');
    assert.strictEqual(signOutStorage.getItem(`${D.CACHE_PREFIX}${ORG}`), null, 'the cached account snapshot is removed on sign out');
  }

  /* --- Home Record surface ------------------------------------------- */
  {
    const recordBackend = createFakeBackend();
    const recordStore = D.createHomeRecordStore({ core: C, storage: createFakeStorage(), token: 'demo-token', fetch: recordBackend.fetch });
    const record = await recordStore.load();
    assert.strictEqual(recordStore.status.mode, 'remote');
    assert.strictEqual(record.property.id, 'prop_1');
    assert.strictEqual(record.access.status, 'invited');

    await recordStore.claim();
    assert.ok(recordBackend.calledWith('POST', 'home-record/demo-token/claim'), 'claiming persists to the backend');
    assert.strictEqual(recordStore.record.access.status, 'claimed', 'the claim state is re-read from the backend');

    await recordStore.book({ opportunityId: 'opp_1' });
    assert.ok(recordBackend.calledWith('POST', 'home-record/demo-token/book'), 'homeowner bookings persist to the backend');
    assert.strictEqual(recordBackend.data.opportunities[0].status, 'booked');

    const missingStore = D.createHomeRecordStore({ core: C, storage: createFakeStorage(), token: 'nope', fetch: recordBackend.fetch });
    await missingStore.load();
    assert.strictEqual(missingStore.status.missing, true, 'an invalid token is a clear not-found state');

    recordBackend.offline = true;
    const demoToken = C.makeDemoState().homeRecordAccess[0].token;
    const offlineStore = D.createHomeRecordStore({ core: C, storage: createFakeStorage(), token: demoToken, fetch: recordBackend.fetch });
    await offlineStore.load();
    assert.strictEqual(offlineStore.status.mode, 'local', 'the homeowner surface also degrades to local data');
    assert.ok(offlineStore.record, 'the offline homeowner surface still renders a record');
  }

  console.log('asktobooked data adapter tests passed');
}

main().catch(error => { console.error(error); process.exit(1); });
