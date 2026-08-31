/**
 * asktobooked data adapter.
 *
 * Every read and write the product performs goes through this layer. When the
 * D1-backed API answers, it is the only source of truth: mutations are sent to
 * the API and the UI is re-rendered from the persisted server response.
 *
 * Browser storage is used for three non-authoritative purposes only:
 *   1. the demo workspace, when no backend is deployed at all
 *   2. an offline fallback, when a reachable backend goes away mid-session
 *   3. a cached snapshot of the last successful sync
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AskToBookedData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_ORGANIZATION_ID = 'org_nwha';
  const CACHE_PREFIX = 'asktobooked_synced_snapshot_v1:';

  const toNumber = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };

  class ApiError extends Error {
    constructor(message, status = 0, details = null, nonJson = false) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.details = details;
      /** True when the response was not this API's JSON envelope at all. */
      this.nonJson = nonJson;
    }
    /**
     * No usable backend: the request failed outright, D1 is not bound, or
     * something other than the API answered (a static host serving an HTML 404,
     * a proxy error page, and so on).
     */
    get isUnreachable() { return this.status === 0 || this.status === 503 || this.nonJson; }
    get isMissing() { return this.status === 404 && !this.nonJson; }
    /** No usable session: the caller must sign in. */
    get isUnauthenticated() { return this.status === 401 && !this.nonJson; }
    /** Signed in, but not a member of the organization that was asked for. */
    get isForbidden() { return this.status === 403 && !this.nonJson; }
  }

  function describeError(error) {
    if (!error) return 'Unknown error';
    if (error instanceof ApiError && error.details) return `${error.message} (${error.details})`;
    return error.message || String(error);
  }

  /* ----------------------------------------------------------------------- */
  /* API client                                                              */
  /* ----------------------------------------------------------------------- */

  function createApiClient(options = {}) {
    const baseUrl = options.baseUrl || '/api';
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

    async function request(method, path, body) {
      if (!fetchImpl) throw new ApiError('No fetch implementation is available', 0);
      // The session lives in an HttpOnly cookie, so it must ride along with
      // every request; it is never readable from script.
      const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, init);
      } catch (error) {
        throw new ApiError(error && error.message ? error.message : 'Network request failed', 0);
      }
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!payload || typeof payload.ok !== 'boolean') {
        throw new ApiError(`No asktobooked API is responding at ${baseUrl} (HTTP ${response.status})`, response.status, null, true);
      }
      if (!response.ok || payload.ok === false) {
        throw new ApiError(payload.error || `API request failed (${response.status})`, response.status, payload.details || null);
      }
      return payload.data;
    }

    const encode = encodeURIComponent;
    return {
      request,
      health: () => request('GET', '/health'),
      session: () => request('GET', '/auth/session'),
      login: (email, password) => request('POST', '/auth/login', { email, password }),
      register: input => request('POST', '/auth/register', input),
      logout: () => request('POST', '/auth/logout', {}),
      organizations: () => request('GET', '/organizations'),
      bootstrap: organizationId => request('GET', organizationId ? `/bootstrap?organization_id=${encode(organizationId)}` : '/bootstrap'),
      updateOrganization: (organizationId, patch) => request('PATCH', `/organizations/${encode(organizationId)}`, patch),
      recalculate: organizationId => request('POST', '/opportunities/recalculate', { organization_id: organizationId }),
      importJobs: (organizationId, rows) => request('POST', '/jobs/import', { organization_id: organizationId, rows }),
      bookOpportunity: (opportunityId, body) => request('POST', `/opportunities/${encode(opportunityId)}/book`, body || {}),
      dismissOpportunity: (opportunityId, body) => request('POST', `/opportunities/${encode(opportunityId)}/dismiss`, body || {}),
      updateAutomationRule: (ruleId, patch) => request('PATCH', `/automation-rules/${encode(ruleId)}`, patch),
      addVisibilitySnapshot: (organizationId, row) => request('POST', '/visibility/snapshots', { organization_id: organizationId, ...row }),
      addVisibilityQuery: (organizationId, row) => request('POST', '/visibility/queries', { organization_id: organizationId, ...row }),
      ensureHomeRecord: propertyId => request('POST', `/homes/${encode(propertyId)}/home-record`, {}),
      homeRecord: token => request('GET', `/home-record/${encode(token)}`),
      claimHomeRecord: token => request('POST', `/home-record/${encode(token)}/claim`, {}),
      bookFromHomeRecord: (token, body) => request('POST', `/home-record/${encode(token)}/book`, body || {}),
      seedDemo: body => request('POST', '/demo/seed', body || {})
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Row <-> client shape mapping                                            */
  /* ----------------------------------------------------------------------- */

  const automationRuleFromRow = row => ({
    id: row.id,
    name: row.name,
    event: row.event_key,
    description: row.description || '',
    channel: row.channel || 'Opportunity',
    enabled: Boolean(toNumber(row.enabled, 0))
  });

  const snapshotFromRow = row => ({
    id: row.id,
    date: String(row.snapshot_date || '').slice(0, 10),
    ai: toNumber(row.ai_mention_rate),
    local: toNumber(row.local_visibility),
    conv: toNumber(row.website_conversion),
    leads: toNumber(row.qualified_leads),
    booked: toNumber(row.booked_jobs),
    reviews: toNumber(row.new_reviews),
    response: toNumber(row.response_minutes)
  });

  const snapshotToRow = input => ({
    snapshot_date: input.date,
    ai_mention_rate: toNumber(input.ai),
    local_visibility: toNumber(input.local),
    website_conversion: toNumber(input.conv),
    qualified_leads: toNumber(input.leads),
    booked_jobs: toNumber(input.booked),
    new_reviews: toNumber(input.reviews),
    response_minutes: toNumber(input.response)
  });

  const queryFromRow = row => ({
    id: row.id,
    query: row.query_text,
    platform: row.platform,
    status: row.status,
    competitor: row.competitor || ''
  });

  const queryToRow = input => ({
    query_text: input.query,
    platform: input.platform,
    status: input.status,
    competitor: input.competitor || ''
  });

  function stateFromBootstrap(payload, core) {
    const state = core.emptyState();
    state.meta.mode = 'remote';
    state.meta.updated_at = new Date().toISOString();
    state.organization = {
      ...state.organization,
      ...payload.organization,
      average_job_value: toNumber(payload.organization && payload.organization.average_job_value),
      monitoring_fee: toNumber(payload.organization && payload.organization.monitoring_fee)
    };
    state.homeowners = payload.homeowners || [];
    state.properties = payload.properties || [];
    state.assets = payload.assets || [];
    state.serviceEvents = payload.serviceEvents || [];
    state.opportunities = (payload.opportunities || []).map(o => ({ ...o, estimated_value: toNumber(o.estimated_value), actual_value: o.actual_value === null || o.actual_value === undefined ? null : toNumber(o.actual_value) }));
    state.interactions = payload.interactions || [];
    state.bookings = payload.bookings || [];
    state.homeRecordAccess = payload.homeRecordAccess || [];
    state.automationRules = (payload.automationRules || []).map(automationRuleFromRow);
    state.visibility = {
      snapshots: ((payload.visibility && payload.visibility.snapshots) || []).map(snapshotFromRow),
      queries: ((payload.visibility && payload.visibility.queries) || []).map(queryFromRow)
    };
    state.audit = core.calculateAudit(state);
    return state;
  }

  function normalizeImportResult(result = {}) {
    return {
      rows_received: toNumber(result.rows_received),
      jobs_imported: toNumber(result.jobs_imported),
      rows_skipped: toNumber(result.rows_skipped),
      new_homes: toNumber(result.new_homes),
      new_homeowners: toNumber(result.new_homeowners),
      unique_homes: toNumber(result.unique_homes),
      unique_homeowners: toNumber(result.unique_homeowners),
      open_opportunities: toNumber(result.open_opportunities !== undefined ? result.open_opportunities : result.opportunities_detected),
      estimated_opportunity_value: toNumber(result.estimated_opportunity_value)
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Storage                                                                 */
  /* ----------------------------------------------------------------------- */

  function createStorage(impl) {
    const store = impl !== undefined ? impl : (typeof localStorage !== 'undefined' ? localStorage : null);
    return {
      get(key) { try { const raw = store && store.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } },
      set(key, value) { try { if (store) store.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
      remove(key) { try { if (store) store.removeItem(key); } catch { /* storage unavailable */ } }
    };
  }

  function resolveCore(options) {
    const core = options.core || (typeof globalThis !== 'undefined' ? globalThis.AskToBookedCore : null);
    if (!core) throw new Error('AskToBookedCore is required by the data adapter');
    return core;
  }

  /* ----------------------------------------------------------------------- */
  /* Dashboard store                                                         */
  /* ----------------------------------------------------------------------- */

  function createStore(options = {}) {
    const core = resolveCore(options);
    const api = options.api || createApiClient(options);
    const storage = createStorage(options.storage);
    const allowLocalFallback = options.allowLocalFallback !== false;

    // Explicitly requested organizations are honoured so a 403 is visible
    // rather than silently swapped for one the user does happen to own.
    const requestedOrganizationId = options.organizationId || null;
    let organizationId = requestedOrganizationId;
    let session = null;
    let state = null;
    let status = { mode: 'unknown', loading: false, syncing: false, error: null, warning: null, needsSeed: false, readOnly: false, unauthenticated: false, lastSyncedAt: null };
    const listeners = new Set();

    const cacheKey = () => `${CACHE_PREFIX}${organizationId || 'unknown'}`;
    const setStatus = patch => { status = { ...status, ...patch }; };
    const emit = () => {
      const snapshot = { ...status };
      for (const listener of [...listeners]) {
        try { listener(state, snapshot); } catch (error) { console.error(error); }
      }
    };

    function applyRemote(payload) {
      state = stateFromBootstrap(payload, core);
      setStatus({ mode: 'remote', loading: false, syncing: false, error: null, warning: null, needsSeed: false, readOnly: false, unauthenticated: false, lastSyncedAt: new Date().toISOString() });
      storage.set(cacheKey(), state);
      emit();
      return state;
    }

    /**
     * Builds local state for the two fallback sources.
     *
     * A cached snapshot of a real account stays read-only: its records belong to
     * D1, so accepting edits here would either be silently discarded on
     * reconnect or fight the server's own opportunity de-duplication. The demo
     * workspace has no backend to contradict, so it stays fully interactive.
     */
    function hydrateLocal(candidate, source) {
      const next = candidate && candidate.organization ? candidate : core.makeDemoState();
      if (!next.meta) next.meta = { version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      if (!next.visibility) next.visibility = { snapshots: [], queries: [] };
      if (!next.automationRules || !next.automationRules.length) next.automationRules = core.defaultAutomationRules();
      if (!next.opportunities) next.opportunities = [];
      if (source !== 'remote-cache') next.opportunities = core.generateOpportunities(next);
      next.audit = core.calculateAudit(next);
      next.meta.mode = 'local';
      next.meta.source = source;
      return next;
    }

    function persistLocal() {
      if (!state || status.readOnly) return state;
      state.audit = core.calculateAudit(state);
      core.touch(state);
      storage.set(core.STORAGE_KEY, state);
      return state;
    }

    function fallbackToLocal(error) {
      if (!allowLocalFallback) {
        setStatus({ loading: false, syncing: false, error: describeError(error) });
        emit();
        return state;
      }
      const cachedSnapshot = storage.get(cacheKey());
      const source = cachedSnapshot ? 'remote-cache' : 'demo';
      state = hydrateLocal(cachedSnapshot || storage.get(core.STORAGE_KEY), source);
      setStatus({
        mode: 'local',
        loading: false,
        syncing: false,
        needsSeed: false,
        unauthenticated: false,
        error: null,
        readOnly: source === 'remote-cache',
        warning: source === 'remote-cache'
          ? 'The backend is unreachable. This is the last synced snapshot of the account and is read-only until the connection returns.'
          : 'The backend is unreachable. Running the local demo workspace — changes made now stay in this browser only.'
      });
      persistLocal();
      emit();
      return state;
    }

    /** Signed in, but there is nothing to show: no membership, or an empty account. */
    function emptyRemoteState() {
      state = core.emptyState();
      state.meta.mode = 'remote';
      if (organizationId) state.organization.id = organizationId;
      setStatus({ mode: 'remote', loading: false, syncing: false, needsSeed: true, readOnly: false, unauthenticated: false, error: null, warning: null });
      emit();
      return state;
    }

    function requireSignIn() {
      session = null;
      state = core.emptyState();
      state.meta.mode = 'remote';
      setStatus({ mode: 'remote', loading: false, syncing: false, needsSeed: false, readOnly: false, unauthenticated: true, error: null, warning: null });
      emit();
      return state;
    }

    async function load() {
      setStatus({ loading: true, error: null, warning: null, needsSeed: false, unauthenticated: false });
      emit();
      try {
        session = await api.session();
        const memberships = (session && session.organizations) || [];
        if (!organizationId) organizationId = memberships.length ? memberships[0].id : null;
        if (!organizationId) return emptyRemoteState();
        return applyRemote(await api.bootstrap(organizationId));
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthenticated) return requireSignIn();
        if (error instanceof ApiError && error.isMissing) return emptyRemoteState();
        if (error instanceof ApiError && error.isUnreachable) return fallbackToLocal(error);
        setStatus({ mode: 'remote', loading: false, syncing: false, readOnly: false, error: describeError(error) });
        if (!state) { state = core.emptyState(); state.meta.mode = 'remote'; if (organizationId) state.organization.id = organizationId; }
        emit();
        return state;
      }
    }

    async function refresh() {
      if (status.mode !== 'remote') { persistLocal(); emit(); return state; }
      return applyRemote(await api.bootstrap(organizationId));
    }

    /**
     * Runs a mutation against whichever source of truth is currently active.
     * In remote mode the UI is always re-rendered from a fresh read of D1 so
     * the screen can never drift from what was actually persisted.
     */
    async function mutate(remoteMutation, localMutation) {
      if (status.mode === 'remote') {
        setStatus({ syncing: true, error: null });
        emit();
        try {
          const result = await remoteMutation();
          await refresh();
          return result;
        } catch (error) {
          if (error instanceof ApiError && error.isUnauthenticated) {
            requireSignIn();
            setStatus({ error: 'That change was not saved: your session has expired.' });
          } else if (error instanceof ApiError && error.isUnreachable) {
            fallbackToLocal(error);
            setStatus({ error: 'That change was not saved: the backend became unreachable.' });
          } else {
            setStatus({ syncing: false, error: describeError(error) });
          }
          emit();
          throw error;
        }
      }
      if (status.readOnly) throw new Error('The backend is unreachable, so this account is read-only until the connection returns.');
      const result = localMutation ? localMutation() : null;
      persistLocal();
      emit();
      return result;
    }

    const findOpportunity = opportunityId => (state && state.opportunities.find(o => o.id === opportunityId)) || null;

    return {
      get state() { return state; },
      get status() { return { ...status }; },
      get mode() { return status.mode; },
      get organizationId() { return organizationId; },
      get user() { return session ? session.user : null; },
      get organizations() { return session ? session.organizations || [] : []; },
      api,

      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      load,
      refresh,

      /** Switches between organizations the session already grants. */
      selectOrganization(nextOrganizationId) {
        if (!nextOrganizationId || nextOrganizationId === organizationId) return Promise.resolve(state);
        organizationId = nextOrganizationId;
        return load();
      },

      async signOut() {
        try { await api.logout(); } catch { /* the cookie is cleared either way */ }
        storage.remove(cacheKey());
        return requireSignIn();
      },

      recalculateOpportunities() {
        return mutate(
          () => api.recalculate(organizationId),
          () => {
            state.opportunities = core.generateOpportunities(state);
            return { open_opportunities: state.opportunities.filter(o => o.status === 'open').length };
          }
        );
      },

      importCSV(text) {
        const rows = core.parseCSV(text);
        if (!rows.length) return Promise.reject(new Error('No CSV rows were found.'));
        return mutate(
          async () => normalizeImportResult(await api.importJobs(organizationId, rows)),
          () => normalizeImportResult(core.importJobsCSV(state, text))
        );
      },

      bookOpportunity(opportunityId, input = {}) {
        const source = input.source || 'contractor_dashboard';
        return mutate(
          () => api.bookOpportunity(opportunityId, { actual_value: input.actualValue ?? null, scheduled_at: input.scheduledAt ?? null, source }),
          () => {
            const opportunity = findOpportunity(opportunityId);
            if (!opportunity) throw new Error('Opportunity not found');
            return core.markBooking(state, { propertyId: opportunity.property_id, opportunityId, actualValue: input.actualValue ?? null, scheduledAt: input.scheduledAt ?? null, source });
          }
        );
      },

      dismissOpportunity(opportunityId) {
        return mutate(
          () => api.dismissOpportunity(opportunityId, {}),
          () => {
            const opportunity = findOpportunity(opportunityId);
            if (!opportunity) throw new Error('Opportunity not found');
            opportunity.status = 'dismissed';
            opportunity.resolved_at = new Date().toISOString();
            return opportunity;
          }
        );
      },

      updateOrganization(patch) {
        return mutate(
          () => api.updateOrganization(organizationId, patch),
          () => Object.assign(state.organization, patch)
        );
      },

      setAutomationRuleEnabled(ruleId, enabled) {
        return mutate(
          () => api.updateAutomationRule(ruleId, { enabled: !!enabled }),
          () => {
            const rule = state.automationRules.find(r => r.id === ruleId);
            if (rule) rule.enabled = !!enabled;
            return rule;
          }
        );
      },

      addVisibilitySnapshot(input) {
        return mutate(
          () => api.addVisibilitySnapshot(organizationId, snapshotToRow(input)),
          () => { const snapshot = { id: core.uid('vis'), ...input }; state.visibility.snapshots.push(snapshot); return snapshot; }
        );
      },

      addVisibilityQuery(input) {
        return mutate(
          () => api.addVisibilityQuery(organizationId, queryToRow(input)),
          () => { const query = { id: core.uid('query'), ...input }; state.visibility.queries.push(query); return query; }
        );
      },

      async ensureHomeRecord(propertyId) {
        const existing = state && state.homeRecordAccess.find(a => a.property_id === propertyId);
        if (existing) return existing;
        await mutate(
          () => api.ensureHomeRecord(propertyId),
          () => core.ensureHomeRecord(state, propertyId)
        );
        return (state && state.homeRecordAccess.find(a => a.property_id === propertyId)) || null;
      },

      async seedDemoOrganization(input = {}) {
        setStatus({ syncing: true, error: null });
        emit();
        try {
          const result = await api.seedDemo({ reset: !!input.reset });
          if (result && result.organization_id) organizationId = result.organization_id;
          await load();
          return result;
        } catch (error) {
          setStatus({ syncing: false, error: describeError(error) });
          emit();
          throw error;
        }
      },

      /** Clears browser copies only. D1 records are never touched from here. */
      clearBrowserData() {
        storage.remove(core.STORAGE_KEY);
        storage.remove(cacheKey());
      },

      loadLocalDemo() {
        setStatus({ mode: 'local', loading: false, syncing: false, needsSeed: false, readOnly: false, unauthenticated: false, error: null, warning: 'Local demo workspace — changes stay in this browser only.' });
        state = hydrateLocal(core.makeDemoState(), 'demo');
        persistLocal();
        emit();
        return state;
      }
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Home Record store (homeowner-facing surface)                            */
  /* ----------------------------------------------------------------------- */

  function createHomeRecordStore(options = {}) {
    const core = resolveCore(options);
    const api = options.api || createApiClient(options);
    const storage = createStorage(options.storage);

    let token = options.token || null;
    let record = null;
    let localState = null;
    let status = { mode: 'unknown', loading: false, syncing: false, error: null, missing: false };
    const listeners = new Set();

    const setStatus = patch => { status = { ...status, ...patch }; };
    const emit = () => {
      const snapshot = { ...status };
      for (const listener of [...listeners]) {
        try { listener(record, snapshot); } catch (error) { console.error(error); }
      }
    };

    function recordFromServer(payload) {
      return {
        access: payload.access,
        organization: payload.organization,
        homeowner: payload.homeowner || null,
        property: payload.property,
        assets: payload.assets || [],
        serviceEvents: payload.serviceEvents || [],
        opportunities: payload.opportunities || []
      };
    }

    function loadLocalState() {
      const stored = storage.get(core.STORAGE_KEY);
      localState = stored && stored.organization ? stored : core.makeDemoState();
      if (!localState.opportunities) localState.opportunities = [];
      return localState;
    }

    function recordFromLocal() {
      const workspace = localState || loadLocalState();
      const access = token
        ? workspace.homeRecordAccess.find(a => a.token === token)
        : workspace.homeRecordAccess[0];
      if (!access) return null;
      token = access.token;
      const detail = core.homeDetail(workspace, access.property_id);
      if (!detail) return null;
      return {
        access,
        organization: workspace.organization,
        homeowner: detail.homeowner,
        property: detail.property,
        assets: detail.assets,
        serviceEvents: detail.serviceEvents.filter(e => e.status === 'completed'),
        opportunities: detail.opportunities.filter(o => o.status === 'open')
      };
    }

    function fallbackToLocal() {
      record = recordFromLocal();
      setStatus({ mode: 'local', loading: false, syncing: false, missing: !record, error: null });
      emit();
      return record;
    }

    async function load() {
      setStatus({ loading: true, error: null, missing: false });
      emit();
      if (!token) return fallbackToLocal();
      try {
        record = recordFromServer(await api.homeRecord(token));
        setStatus({ mode: 'remote', loading: false, syncing: false, missing: false, error: null });
        emit();
        return record;
      } catch (error) {
        if (error instanceof ApiError && error.isUnreachable) return fallbackToLocal();
        if (error instanceof ApiError && error.isMissing) {
          record = null;
          setStatus({ mode: 'remote', loading: false, syncing: false, missing: true, error: null });
          emit();
          return null;
        }
        setStatus({ mode: 'remote', loading: false, syncing: false, error: describeError(error) });
        emit();
        return record;
      }
    }

    async function mutate(remoteMutation, localMutation) {
      if (status.mode === 'remote') {
        setStatus({ syncing: true, error: null });
        emit();
        try {
          const result = await remoteMutation();
          await load();
          return result;
        } catch (error) {
          setStatus({ syncing: false, error: describeError(error) });
          emit();
          throw error;
        }
      }
      const workspace = localState || loadLocalState();
      const result = localMutation ? localMutation() : null;
      core.touch(workspace);
      storage.set(core.STORAGE_KEY, workspace);
      record = recordFromLocal();
      setStatus({ syncing: false });
      emit();
      return result;
    }

    return {
      get record() { return record; },
      get status() { return { ...status }; },
      get token() { return token; },
      api,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      load,
      claim() {
        return mutate(
          () => api.claimHomeRecord(token),
          () => core.claimHomeRecord(localState || loadLocalState(), token)
        );
      },
      book(input = {}) {
        return mutate(
          () => api.bookFromHomeRecord(token, { opportunity_id: input.opportunityId || null, scheduled_at: input.scheduledAt || null }),
          () => {
            if (!record) throw new Error('Home Record not loaded');
            return core.markBooking(localState || loadLocalState(), { propertyId: record.property.id, opportunityId: input.opportunityId || null, source: 'home_record' });
          }
        );
      }
    };
  }

  return {
    ApiError,
    DEFAULT_ORGANIZATION_ID,
    CACHE_PREFIX,
    createApiClient,
    createStore,
    createHomeRecordStore,
    stateFromBootstrap,
    normalizeImportResult,
    automationRuleFromRow,
    snapshotFromRow,
    snapshotToRow,
    queryFromRow,
    queryToRow
  };
});
