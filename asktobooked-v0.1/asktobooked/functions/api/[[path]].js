const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const fail = (message, status = 400, details) => json({ ok: false, error: message, ...(details ? { details } : {}) }, status);
const id = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
const clean = v => String(v ?? '').trim();
const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const bool = v => v === true || v === 1 || v === '1' || v === 'true';
const normalizeAddress = (...parts) => parts.filter(Boolean).join(' ').toLowerCase().replace(/\b(street)\b/g,'st').replace(/\b(avenue)\b/g,'ave').replace(/\b(road)\b/g,'rd').replace(/\b(drive)\b/g,'dr').replace(/\b(lane)\b/g,'ln').replace(/\b(court)\b/g,'ct').replace(/\b(boulevard)\b/g,'blvd').replace(/[^a-z0-9]/g,'');
const normalizePhone = v => clean(v).replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');

const DAY = 86400000;
const DEMO_ORGANIZATION_ID = 'org_nwha';
const DEMO_USER_EMAIL = 'owner@northwestheating.example';
const DEMO_USER_PASSWORD = 'asktobooked-demo';
const dateOnly = value => new Date(value).toISOString().slice(0, 10);
const daysAgo = days => new Date(Date.now() - days * DAY);

async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new HttpError('Expected application/json', 400);
  try { return await request.json(); } catch { throw new HttpError('Request body is not valid JSON', 400); }
}

// Routes that accept an optional body (toggles, claims) must not fail on an empty request.
async function readOptionalBody(request) {
  try { return (await readBody(request)) || {}; } catch { return {}; }
}

/* ---------------------------------------------------------------------------
 * Authentication and tenant isolation
 *
 * Contractors authenticate with an opaque session token delivered in an
 * HttpOnly cookie; only its SHA-256 is stored, so read access to D1 does not
 * hand over live sessions. Homeowners are deliberately not users at all - a
 * Home Record is a capability URL scoped to exactly one property, and it can
 * never be presented as a contractor session.
 *
 * The permitted organization set is derived from the session on every request.
 * An organization_id sent by the browser is only ever used after it has been
 * checked against that set.
 * ------------------------------------------------------------------------- */

const SESSION_COOKIE = 'atb_session';
const SESSION_TTL_DAYS = 30;
const MIN_PASSWORD_LENGTH = 12;
// Production Workers rejects PBKDF2 above 100k iterations, so this is the
// ceiling rather than the OWASP-preferred 600k. The count is stored per hash so
// it can be raised if the platform limit is lifted.
const PBKDF2_ITERATIONS = 100000;

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'HttpError'; this.status = status; }
}

const textEncoder = new TextEncoder();
const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const toBase64Url = bytes => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derivePassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(await derivePassword(password, salt, iterations))}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000000) return false;
  let salt, expected;
  try { salt = fromBase64(parts[2]); expected = fromBase64(parts[3]); } catch { return false; }
  return timingSafeEqual(await derivePassword(password, salt, iterations), expected);
}

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function sessionCookie(token, url, maxAgeSeconds) {
  const attributes = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (url.protocol === 'https:') attributes.push('Secure');
  return attributes.join('; ');
}

async function createSession(DB, userId, request, url) {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * DAY).toISOString();
  await DB.prepare('INSERT INTO sessions (id,token_hash,user_id,expires_at,user_agent) VALUES (?,?,?,?,?)')
    .bind(id('session'), await sha256Hex(token), userId, expiresAt, clean(request.headers.get('user-agent')).slice(0, 255) || null).run();
  await DB.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(userId).run();
  return { 'set-cookie': sessionCookie(token, url, SESSION_TTL_DAYS * 86400) };
}

/**
 * Resolves the caller's session, or null. Expired sessions are deleted on
 * sight so a stolen-but-stale cookie cannot be replayed.
 */
async function resolveSession(DB, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await DB.prepare(`SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.name, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(await sha256Hex(token)).first();
  if (!row) return null;
  if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) {
    await DB.prepare('DELETE FROM sessions WHERE id=?').bind(row.session_id).run();
    return null;
  }
  if (row.status !== 'active') return null;
  const memberships = (await DB.prepare('SELECT organization_id, role FROM organization_members WHERE user_id=? ORDER BY created_at ASC').bind(row.user_id).all()).results;
  return {
    sessionId: row.session_id,
    user: { id: row.user_id, email: row.email, name: row.name || '' },
    organizationIds: memberships.map(m => m.organization_id),
    roles: Object.fromEntries(memberships.map(m => [m.organization_id, m.role]))
  };
}

const requireSession = auth => {
  if (!auth) throw new HttpError('Authentication required', 401);
  return auth;
};

/**
 * The only place a browser-supplied organization_id is allowed to become
 * trusted. Unauthorized access to a named organization is a 403 because the
 * caller already asserted the identifier.
 */
function requireOrganization(auth, organizationId) {
  requireSession(auth);
  const orgId = clean(organizationId);
  if (!orgId) throw new HttpError('organization_id is required', 400);
  if (!auth.organizationIds.includes(orgId)) throw new HttpError('You do not have access to this organization', 403);
  return orgId;
}

/**
 * Loads a row addressed by an opaque id and hides it unless the caller is a
 * member of its organization. Cross-tenant ids read as 404 rather than 403 so
 * the API never confirms that another tenant's identifier exists.
 */
async function scopedRow(DB, sql, value, auth) {
  requireSession(auth);
  const row = await DB.prepare(sql).bind(value).first();
  if (!row || !auth.organizationIds.includes(row.organization_id)) return null;
  return row;
}

/**
 * Cookie auth means state-changing requests need CSRF protection. SameSite
 * blocks the common cases; this rejects anything that still arrives from
 * another origin. A missing Origin means a non-browser client, which cannot be
 * a CSRF victim.
 */
function assertSameOrigin(request, url) {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return;
  let originUrl;
  try { originUrl = new URL(origin); } catch { throw new HttpError('Cross-origin request rejected', 403); }
  if (originUrl.host !== url.host) throw new HttpError('Cross-origin request rejected', 403);
}

const publicUser = auth => ({ id: auth.user.id, email: auth.user.email, name: auth.user.name });

async function sessionPayload(DB, auth) {
  const organizations = auth.organizationIds.length
    ? (await DB.prepare(`SELECT id,name,slug,industry,city,state,service_area FROM organizations WHERE id IN (${auth.organizationIds.map(() => '?').join(',')}) ORDER BY name ASC`)
        .bind(...auth.organizationIds).all()).results
    : [];
  return { user: publicUser(auth), organizations: organizations.map(o => ({ ...o, role: auth.roles[o.id] || 'member' })) };
}

async function registerUser(DB, body, request, url) {
  const email = clean(body.email).toLowerCase();
  const password = String(body.password ?? '');
  const organizationName = clean(body.organization_name) || 'My Company';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError('A valid email address is required', 400);
  if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  if (await DB.prepare('SELECT id FROM users WHERE email_normalized=?').bind(email).first()) {
    throw new HttpError('An account with that email already exists', 409);
  }
  const userId = id('user');
  const organizationId = id('org');
  const baseSlug = organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
  const slug = (await DB.prepare('SELECT id FROM organizations WHERE slug=?').bind(baseSlug).first())
    ? `${baseSlug}-${organizationId.slice(-6)}` : baseSlug;
  await DB.batch([
    DB.prepare('INSERT INTO users (id,email,email_normalized,name,password_hash) VALUES (?,?,?,?,?)')
      .bind(userId, clean(body.email), email, clean(body.name) || null, await hashPassword(password)),
    DB.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').bind(organizationId, organizationName, slug),
    DB.prepare("INSERT INTO organization_members (id,organization_id,user_id,role) VALUES (?,?,?,'owner')")
      .bind(id('member'), organizationId, userId)
  ]);
  await ensureAutomationRules(DB, organizationId);
  const headers = await createSession(DB, userId, request, url);
  const auth = { user: { id: userId, email: clean(body.email), name: clean(body.name) }, organizationIds: [organizationId], roles: { [organizationId]: 'owner' } };
  return { headers, data: await sessionPayload(DB, auth) };
}

async function loginUser(DB, body, request, url) {
  const email = clean(body.email).toLowerCase();
  const password = String(body.password ?? '');
  const user = await DB.prepare('SELECT * FROM users WHERE email_normalized=?').bind(email).first();
  // Same message and roughly the same work for unknown users and wrong
  // passwords, so login cannot be used to enumerate accounts.
  const valid = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(password, `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(new Uint8Array(16))}$${toBase64(new Uint8Array(32))}`);
  if (!user || !valid || user.status !== 'active') throw new HttpError('Invalid email or password', 401);
  const headers = await createSession(DB, user.id, request, url);
  const memberships = (await DB.prepare('SELECT organization_id, role FROM organization_members WHERE user_id=? ORDER BY created_at ASC').bind(user.id).all()).results;
  const auth = {
    user: { id: user.id, email: user.email, name: user.name || '' },
    organizationIds: memberships.map(m => m.organization_id),
    roles: Object.fromEntries(memberships.map(m => [m.organization_id, m.role]))
  };
  return { headers, data: await sessionPayload(DB, auth) };
}

async function getOrganization(DB, organizationId) {
  return DB.prepare('SELECT * FROM organizations WHERE id = ?').bind(organizationId).first();
}

const DEFAULT_AUTOMATION_RULES = [
  { event_key: 'asset.service_due', name: 'Maintenance due', channel: 'Opportunity', description: 'Create an opportunity when HVAC equipment has not had maintenance in the last 330 days.' },
  { event_key: 'estimate.aged_7d', name: 'Open estimate follow-up', channel: 'Opportunity', description: 'Flag estimates that remain open for at least seven days.' },
  { event_key: 'relationship.dormant_24m', name: 'Dormant homeowner', channel: 'Opportunity', description: 'Surface paying customers with no completed service in 24 months.' },
  { event_key: 'asset.replacement_window', name: 'Replacement window', channel: 'Opportunity', description: 'Surface aging equipment, prioritizing homes with repeated recent repairs.' },
  { event_key: 'job.completed', name: 'Home Record invitation', channel: 'Home Record', description: 'Flag recently completed jobs whose homeowner has not claimed a Home Record.' },
  { event_key: 'relationship.repeat_customer', name: 'Membership opportunity', channel: 'Opportunity', description: 'Surface repeat customers who have no active maintenance membership recorded.' }
];

async function ensureAutomationRules(DB, organizationId) {
  const existing = await DB.prepare('SELECT COUNT(*) AS count FROM automation_rules WHERE organization_id = ?').bind(organizationId).first();
  if (Number(existing?.count || 0) > 0) return;
  await DB.batch(DEFAULT_AUTOMATION_RULES.map(rule =>
    DB.prepare('INSERT OR IGNORE INTO automation_rules (id,organization_id,name,event_key,description,channel,enabled) VALUES (?,?,?,?,?,?,1)')
      .bind(id('rule'), organizationId, rule.name, rule.event_key, rule.description, rule.channel)));
}

async function bootstrap(DB, organizationId) {
  const organization = await getOrganization(DB, organizationId);
  if (!organization) return null;
  await ensureAutomationRules(DB, organizationId);
  const [homeowners, properties, assets, serviceEvents, opportunities, interactions, bookings, homeRecordAccess, snapshots, queries, automationRules] = await Promise.all([
    DB.prepare('SELECT * FROM homeowners WHERE organization_id = ? ORDER BY created_at DESC').bind(organizationId).all(),
    DB.prepare('SELECT * FROM properties WHERE organization_id = ? ORDER BY created_at DESC').bind(organizationId).all(),
    DB.prepare('SELECT * FROM assets WHERE organization_id = ? ORDER BY created_at DESC').bind(organizationId).all(),
    DB.prepare('SELECT * FROM service_events WHERE organization_id = ? ORDER BY service_date DESC').bind(organizationId).all(),
    DB.prepare('SELECT * FROM opportunities WHERE organization_id = ? ORDER BY CASE confidence WHEN \'high\' THEN 3 WHEN \'medium\' THEN 2 ELSE 1 END DESC, estimated_value DESC').bind(organizationId).all(),
    DB.prepare('SELECT * FROM interactions WHERE organization_id = ? ORDER BY occurred_at DESC LIMIT 1000').bind(organizationId).all(),
    DB.prepare('SELECT * FROM bookings WHERE organization_id = ? ORDER BY created_at DESC').bind(organizationId).all(),
    DB.prepare('SELECT hra.* FROM home_record_access hra JOIN properties p ON p.id = hra.property_id WHERE p.organization_id = ?').bind(organizationId).all(),
    DB.prepare('SELECT * FROM visibility_snapshots WHERE organization_id = ? ORDER BY snapshot_date DESC').bind(organizationId).all(),
    DB.prepare('SELECT * FROM visibility_queries WHERE organization_id = ? ORDER BY created_at DESC').bind(organizationId).all(),
    DB.prepare('SELECT * FROM automation_rules WHERE organization_id = ? ORDER BY created_at ASC').bind(organizationId).all()
  ]);
  return { organization, homeowners: homeowners.results, properties: properties.results, assets: assets.results, serviceEvents: serviceEvents.results, opportunities: opportunities.results, interactions: interactions.results, bookings: bookings.results, homeRecordAccess: homeRecordAccess.results, visibility: { snapshots: snapshots.results, queries: queries.results }, automationRules: automationRules.results };
}

const ORGANIZATION_FIELDS = ['name','slug','industry','city','state','service_area','phone','email','website','booking_url','logo_url','average_job_value','monitoring_fee'];
const NUMERIC_ORGANIZATION_FIELDS = new Set(['average_job_value','monitoring_fee']);

async function updateOrganization(DB, organizationId, patch = {}) {
  const organization = await getOrganization(DB, organizationId);
  if (!organization) return null;
  const entries = ORGANIZATION_FIELDS.filter(field => patch[field] !== undefined)
    .map(field => [field, NUMERIC_ORGANIZATION_FIELDS.has(field) ? num(patch[field]) : clean(patch[field])]);
  if (!entries.length) return organization;
  await DB.prepare(`UPDATE organizations SET ${entries.map(([field]) => `${field}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(...entries.map(([, value]) => value), organizationId).run();
  return getOrganization(DB, organizationId);
}

async function upsertOpportunity(DB, o) {
  const existing = await DB.prepare('SELECT id, status FROM opportunities WHERE dedupe_key = ?').bind(o.dedupe_key).first();
  if (existing && existing.status !== 'open') return existing;
  if (existing) {
    await DB.prepare(`UPDATE opportunities SET title=?, reason=?, estimated_value=?, due_date=?, confidence=?, homeowner_id=?, asset_id=?, source_service_event_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(o.title,o.reason,o.estimated_value,o.due_date,o.confidence,o.homeowner_id||null,o.asset_id||null,o.source_service_event_id||null,existing.id).run();
    return { id: existing.id, status: 'open' };
  }
  const opportunityId = id('opp');
  await DB.prepare(`INSERT INTO opportunities (id,dedupe_key,organization_id,property_id,homeowner_id,asset_id,source_service_event_id,type,title,reason,estimated_value,due_date,confidence,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open')`)
    .bind(opportunityId,o.dedupe_key,o.organization_id,o.property_id,o.homeowner_id||null,o.asset_id||null,o.source_service_event_id||null,o.type,o.title,o.reason,o.estimated_value,o.due_date,o.confidence).run();
  return { id: opportunityId, status: 'open' };
}

async function recalculateOpportunities(DB, organizationId) {
  const created = [];
  const assets = (await DB.prepare(`
    SELECT a.*, p.homeowner_id,
      COALESCE(MAX(CASE WHEN se.status='completed' AND se.type IN ('maintenance','installation') THEN se.service_date END), a.install_date) AS last_service_basis,
      SUM(CASE WHEN se.status='completed' AND se.type='repair' AND se.service_date >= date('now','-730 days') THEN 1 ELSE 0 END) AS repair_count_24m,
      SUM(CASE WHEN se.status='completed' AND se.type='repair' AND se.service_date >= date('now','-730 days') THEN se.amount ELSE 0 END) AS repair_spend_24m
    FROM assets a JOIN properties p ON p.id=a.property_id
    LEFT JOIN service_events se ON se.asset_id=a.id
    WHERE a.organization_id=? GROUP BY a.id`).bind(organizationId).all()).results;

  for (const a of assets) {
    if (a.last_service_basis && new Date(a.last_service_basis) <= new Date(Date.now() - 330*86400000)) {
      created.push(await upsertOpportunity(DB,{dedupe_key:`maintenance_due:${a.property_id}:${a.id}:`,organization_id:organizationId,property_id:a.property_id,homeowner_id:a.homeowner_id,asset_id:a.id,type:'maintenance_due',title:'Annual maintenance due',reason:`${a.manufacturer||''} ${a.model||a.category} has not had recorded maintenance/service in at least 330 days.`,estimated_value:249,due_date:new Date().toISOString().slice(0,10),confidence:'high'}));
    }
    const ageYears = a.install_date ? (Date.now()-new Date(a.install_date).getTime())/(365.25*86400000) : 0;
    if (ageYears >= 12) {
      const high = Number(a.repair_count_24m||0)>=2 || ageYears>=16;
      created.push(await upsertOpportunity(DB,{dedupe_key:`replacement_window:${a.property_id}:${a.id}:`,organization_id:organizationId,property_id:a.property_id,homeowner_id:a.homeowner_id,asset_id:a.id,type:'replacement_window',title:'Equipment entering replacement window',reason:`Equipment is ${ageYears.toFixed(1)} years old${Number(a.repair_count_24m||0)?` with ${a.repair_count_24m} recent repair(s) totaling $${Number(a.repair_spend_24m||0).toFixed(0)}`:''}.`,estimated_value:10500,due_date:new Date().toISOString().slice(0,10),confidence:high?'high':'medium'}));
    }
  }

  const estimates = (await DB.prepare(`SELECT se.*, p.homeowner_id FROM service_events se JOIN properties p ON p.id=se.property_id WHERE se.organization_id=? AND se.type='estimate' AND se.status='open' AND se.service_date <= date('now','-7 days')`).bind(organizationId).all()).results;
  for (const e of estimates) created.push(await upsertOpportunity(DB,{dedupe_key:`open_estimate:${e.property_id}:${e.asset_id||''}:${e.id}`,organization_id:organizationId,property_id:e.property_id,homeowner_id:e.homeowner_id,asset_id:e.asset_id,source_service_event_id:e.id,type:'open_estimate',title:`Open $${Number(e.amount||0).toLocaleString()} estimate`,reason:'Estimate has remained open for at least seven days with no accepted booking recorded.',estimated_value:Number(e.amount||0),due_date:new Date().toISOString().slice(0,10),confidence:'high'}));

  const dormant = (await DB.prepare(`SELECT p.id property_id,p.homeowner_id,MAX(se.service_date) last_service,MAX(se.id) source_id,MAX(se.amount) last_amount FROM properties p JOIN service_events se ON se.property_id=p.id AND se.status='completed' AND se.type<>'estimate' WHERE p.organization_id=? GROUP BY p.id HAVING MAX(se.service_date) <= date('now','-730 days')`).bind(organizationId).all()).results;
  for (const d of dormant) created.push(await upsertOpportunity(DB,{dedupe_key:`dormant_relationship:${d.property_id}::${d.source_id}`,organization_id:organizationId,property_id:d.property_id,homeowner_id:d.homeowner_id,source_service_event_id:d.source_id,type:'dormant_relationship',title:'Dormant homeowner relationship',reason:'Previously paying homeowner has had no recorded completed service in at least 24 months.',estimated_value:Math.max(350,Math.round(Number(d.last_amount||0)*.18/50)*50),due_date:new Date().toISOString().slice(0,10),confidence:'medium'}));

  const continuity = (await DB.prepare(`SELECT p.id property_id,p.homeowner_id,MAX(se.id) source_id,MAX(se.service_date) service_date FROM properties p JOIN service_events se ON se.property_id=p.id AND se.status='completed' LEFT JOIN home_record_access hra ON hra.property_id=p.id WHERE p.organization_id=? AND se.service_date >= date('now','-120 days') AND COALESCE(hra.status,'') <> 'claimed' GROUP BY p.id`).bind(organizationId).all()).results;
  for (const c of continuity) created.push(await upsertOpportunity(DB,{dedupe_key:`continuity_gap:${c.property_id}::${c.source_id}`,organization_id:organizationId,property_id:c.property_id,homeowner_id:c.homeowner_id,source_service_event_id:c.source_id,type:'continuity_gap',title:'Homeowner relationship not retained',reason:'A recent completed job exists, but the homeowner has not claimed a Home Record.',estimated_value:249,due_date:new Date().toISOString().slice(0,10),confidence:'high'}));

  const membership = (await DB.prepare(`SELECT p.id property_id,p.homeowner_id,COUNT(se.id) paid_count,MAX(se.id) source_id FROM properties p JOIN service_events se ON se.property_id=p.id AND se.status='completed' AND se.amount>0 AND se.type<>'estimate' WHERE p.organization_id=? AND NOT EXISTS (SELECT 1 FROM service_events m WHERE m.property_id=p.id AND m.type='membership' AND m.status='active') GROUP BY p.id HAVING COUNT(se.id)>=2`).bind(organizationId).all()).results;
  for (const m of membership) created.push(await upsertOpportunity(DB,{dedupe_key:`membership:${m.property_id}::${m.source_id}`,organization_id:organizationId,property_id:m.property_id,homeowner_id:m.homeowner_id,source_service_event_id:m.source_id,type:'membership',title:'Maintenance membership opportunity',reason:`This home has ${m.paid_count} completed paid service events but no active maintenance membership recorded.`,estimated_value:299,due_date:new Date().toISOString().slice(0,10),confidence:Number(m.paid_count)>=3?'high':'medium'}));

  const count = await DB.prepare(`SELECT COUNT(*) count, COALESCE(SUM(estimated_value),0) value FROM opportunities WHERE organization_id=? AND status='open'`).bind(organizationId).first();
  return { evaluated_assets: assets.length, rules_written: created.length, open_opportunities: count.count, estimated_opportunity_value: count.value };
}

async function accountTotals(DB, organizationId) {
  return DB.prepare(`SELECT
      (SELECT COUNT(*) FROM properties WHERE organization_id=?) unique_homes,
      (SELECT COUNT(*) FROM homeowners WHERE organization_id=?) unique_homeowners,
      (SELECT COUNT(*) FROM service_events WHERE organization_id=?) service_events,
      (SELECT COUNT(*) FROM opportunities WHERE organization_id=? AND status='open') open_opportunities,
      (SELECT COALESCE(SUM(estimated_value),0) FROM opportunities WHERE organization_id=? AND status='open') estimated_opportunity_value`)
    .bind(organizationId, organizationId, organizationId, organizationId, organizationId).first();
}

async function importJobs(DB, organizationId, rows) {
  let imported=0, skipped=0, newHomes=0, newHomeowners=0;
  for (const r of rows || []) {
    const address=clean(r.address||r.address_line_1||r.street_address); if(!address){skipped++;continue}
    const first=clean(r.first_name||r.firstname||r.customer_first_name), last=clean(r.last_name||r.lastname||r.customer_last_name||r.customer||r.name);
    const email=clean(r.email||r.customer_email).toLowerCase(), phone=clean(r.phone||r.customer_phone);
    const city=clean(r.city), state=clean(r.state||r.region), postal=clean(r.zip||r.postal_code||r.zip_code);
    const normalized=normalizeAddress(address,city,state,postal);
    let homeowner=null;
    if(email) homeowner=await DB.prepare('SELECT * FROM homeowners WHERE organization_id=? AND lower(email)=? LIMIT 1').bind(organizationId,email).first();
    if(!homeowner && phone) homeowner=await DB.prepare("SELECT * FROM homeowners WHERE organization_id=? AND replace(replace(replace(replace(phone,'(',''),')',''),'-',''),' ','') LIKE ? LIMIT 1").bind(organizationId,`%${normalizePhone(phone)}`).first();
    if(!homeowner){const homeownerId=id('homeowner');await DB.prepare('INSERT INTO homeowners (id,organization_id,first_name,last_name,email,phone) VALUES (?,?,?,?,?,?)').bind(homeownerId,organizationId,first,last,email,phone).run();homeowner={id:homeownerId};newHomeowners++;}
    let property=await DB.prepare('SELECT * FROM properties WHERE organization_id=? AND normalized_address=?').bind(organizationId,normalized).first();
    if(!property){const propertyId=id('property');await DB.prepare('INSERT INTO properties (id,organization_id,homeowner_id,address_line_1,city,state,postal_code,normalized_address) VALUES (?,?,?,?,?,?,?,?)').bind(propertyId,organizationId,homeowner.id,address,city,state,postal,normalized).run();property={id:propertyId,homeowner_id:homeowner.id};newHomes++;const token=`home-${crypto.randomUUID()}`;await DB.prepare("INSERT INTO home_record_access (id,property_id,homeowner_id,token,status) VALUES (?,?,?,?,'invited')").bind(id('access'),propertyId,homeowner.id,token).run();}
    const jobType=clean(r.job_type||r.service||r.description||'Service job'); const amount=Number(String(r.amount||r.revenue||r.total||0).replace(/[$,]/g,''))||0; const serviceDate=clean(r.job_date||r.service_date||r.date)||new Date().toISOString().slice(0,10);
    const type=/estimate|quote/i.test(jobType)?'estimate':/maint|tune|service plan/i.test(jobType)?'maintenance':/install|replace|replacement/i.test(jobType)?'installation':/repair|diagnostic|no heat|no cool/i.test(jobType)?'repair':'service';
    let assetId=null;
    if(type==='installation'){assetId=id('asset');const category=/furnace/i.test(jobType)?'Furnace':/ac|air conditioner/i.test(jobType)?'Air Conditioner':'Heat Pump';await DB.prepare('INSERT INTO assets (id,organization_id,property_id,category,manufacturer,model,serial_number,install_date,estimated_lifespan_years) VALUES (?,?,?,?,?,?,?,?,?)').bind(assetId,organizationId,property.id,category,clean(r.manufacturer),clean(r.model),clean(r.serial_number),serviceDate,Number(r.estimated_lifespan_years||15)).run();}
    await DB.prepare('INSERT INTO service_events (id,organization_id,property_id,homeowner_id,asset_id,type,service_date,description,amount,status) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id('event'),organizationId,property.id,homeowner.id,assetId,type,serviceDate,jobType,amount,type==='estimate'?'open':'completed').run(); imported++;
  }
  const engine=await recalculateOpportunities(DB,organizationId);
  const totals=await accountTotals(DB,organizationId);
  return { rows_received:(rows||[]).length,jobs_imported:imported,rows_skipped:skipped,new_homes:newHomes,new_homeowners:newHomeowners,...engine,...totals };
}

async function bookOpportunity(DB, opportunityId, body = {}) {
  const opportunity = await DB.prepare('SELECT * FROM opportunities WHERE id=?').bind(opportunityId).first();
  if (!opportunity) return null;
  const actualValue = body.actual_value === undefined || body.actual_value === null || body.actual_value === '' ? null : num(body.actual_value);
  const bookingId = id('booking');
  await DB.batch([
    DB.prepare('INSERT INTO bookings (id,organization_id,property_id,homeowner_id,opportunity_id,scheduled_at,status,estimated_value,actual_value) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(bookingId, opportunity.organization_id, opportunity.property_id, opportunity.homeowner_id, opportunityId, clean(body.scheduled_at) || dateOnly(new Date(Date.now() + 3 * DAY)), 'requested', num(opportunity.estimated_value), actualValue),
    DB.prepare("UPDATE opportunities SET status='booked', actual_value=COALESCE(?,actual_value), resolved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(actualValue, opportunityId),
    DB.prepare("INSERT INTO interactions (id,organization_id,property_id,homeowner_id,opportunity_id,type,direction,status,source,value) VALUES (?,?,?,?,?,'booking_request','inbound','completed',?,?)")
      .bind(id('interaction'), opportunity.organization_id, opportunity.property_id, opportunity.homeowner_id, opportunityId, clean(body.source) || 'contractor_dashboard', actualValue ?? num(opportunity.estimated_value))
  ]);
  return { booking_id: bookingId, opportunity_id: opportunityId, status: 'booked' };
}

async function dismissOpportunity(DB, opportunityId, body = {}) {
  const opportunity = await DB.prepare('SELECT * FROM opportunities WHERE id=?').bind(opportunityId).first();
  if (!opportunity) return null;
  await DB.batch([
    DB.prepare("UPDATE opportunities SET status='dismissed', resolved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(opportunityId),
    DB.prepare("INSERT INTO interactions (id,organization_id,property_id,homeowner_id,opportunity_id,type,direction,status,source) VALUES (?,?,?,?,?,'opportunity_dismissed','system','completed',?)")
      .bind(id('interaction'), opportunity.organization_id, opportunity.property_id, opportunity.homeowner_id, opportunityId, clean(body.source) || 'contractor_dashboard')
  ]);
  return { opportunity_id: opportunityId, status: 'dismissed' };
}

async function ensureHomeRecordAccess(DB, propertyId) {
  const property = await DB.prepare('SELECT * FROM properties WHERE id=?').bind(propertyId).first();
  if (!property) return null;
  const existing = await DB.prepare('SELECT * FROM home_record_access WHERE property_id=?').bind(propertyId).first();
  if (existing) return existing;
  const accessId = id('access');
  await DB.prepare("INSERT INTO home_record_access (id,property_id,homeowner_id,token,status) VALUES (?,?,?,?,'invited')")
    .bind(accessId, propertyId, property.homeowner_id, `home-${crypto.randomUUID()}`).run();
  return DB.prepare('SELECT * FROM home_record_access WHERE id=?').bind(accessId).first();
}

async function setAutomationRule(DB, ruleId, body = {}) {
  const rule = await DB.prepare('SELECT * FROM automation_rules WHERE id=?').bind(ruleId).first();
  if (!rule) return null;
  if (body.enabled !== undefined) {
    await DB.prepare('UPDATE automation_rules SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(bool(body.enabled) ? 1 : 0, ruleId).run();
  }
  return DB.prepare('SELECT * FROM automation_rules WHERE id=?').bind(ruleId).first();
}

async function addVisibilitySnapshot(DB, organizationId, body = {}) {
  const snapshotId = id('vis');
  await DB.prepare('INSERT INTO visibility_snapshots (id,organization_id,snapshot_date,ai_mention_rate,local_visibility,website_conversion,qualified_leads,booked_jobs,new_reviews,response_minutes) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(snapshotId, organizationId, clean(body.snapshot_date) || dateOnly(new Date()), num(body.ai_mention_rate), num(body.local_visibility), num(body.website_conversion), Math.round(num(body.qualified_leads)), Math.round(num(body.booked_jobs)), Math.round(num(body.new_reviews)), num(body.response_minutes)).run();
  return DB.prepare('SELECT * FROM visibility_snapshots WHERE id=?').bind(snapshotId).first();
}

async function addVisibilityQuery(DB, organizationId, body = {}) {
  const queryText = clean(body.query_text);
  if (!queryText) return null;
  const queryId = id('query');
  await DB.prepare('INSERT INTO visibility_queries (id,organization_id,query_text,platform,status,competitor) VALUES (?,?,?,?,?,?)')
    .bind(queryId, organizationId, queryText, clean(body.platform) || 'ChatGPT', clean(body.status) || 'Unknown', clean(body.competitor) || null).run();
  return DB.prepare('SELECT * FROM visibility_queries WHERE id=?').bind(queryId).first();
}

/* ---------------------------------------------------------------------------
 * Home Records (homeowner-facing surface)
 *
 * A token is a capability for exactly one property. Everything below is scoped
 * by access.property_id, and the responses are explicit allow-lists rather than
 * SELECT *, so contractor-internal fields (pricing inputs, dedupe keys, consent
 * state, other homes) cannot leak through this surface.
 * ------------------------------------------------------------------------- */

/** Resolves a token to its access row, rejecting revoked and expired links. */
async function loadHomeRecordAccess(DB, token) {
  const access = await DB.prepare(`SELECT hra.id, hra.property_id, hra.token, hra.status, hra.claimed_at, hra.expires_at,
      COALESCE(hra.homeowner_id, p.homeowner_id) AS homeowner_id,
      p.organization_id, p.address_line_1, p.address_line_2, p.city, p.state, p.postal_code
    FROM home_record_access hra JOIN properties p ON p.id = hra.property_id
    WHERE hra.token = ? AND hra.status <> 'revoked'`).bind(clean(token)).first();
  if (!access) return null;
  if (access.expires_at && new Date(access.expires_at).getTime() <= Date.now()) return null;
  return access;
}

const pick = (row, fields) => (row ? Object.fromEntries(fields.map(field => [field, row[field] ?? null])) : null);

const HOME_RECORD_ORGANIZATION = ['id','name','industry','city','state','service_area','phone','email','website','booking_url','logo_url'];
const HOME_RECORD_HOMEOWNER = ['first_name','last_name','email','phone'];
const HOME_RECORD_ASSET = ['id','category','manufacturer','model','install_date','warranty_expiration'];
const HOME_RECORD_EVENT = ['id','type','service_date','description','amount'];
const HOME_RECORD_OPPORTUNITY = ['id','type','title','reason','estimated_value','due_date','confidence','status'];

async function homeRecord(DB, token) {
  const access = await loadHomeRecordAccess(DB, token);
  if (!access) return null;
  const [organization, homeowner, assets, serviceEvents, opportunities] = await Promise.all([
    DB.prepare(`SELECT ${HOME_RECORD_ORGANIZATION.join(',')} FROM organizations WHERE id=?`).bind(access.organization_id).first(),
    access.homeowner_id ? DB.prepare(`SELECT ${HOME_RECORD_HOMEOWNER.join(',')} FROM homeowners WHERE id=?`).bind(access.homeowner_id).first() : null,
    DB.prepare(`SELECT ${HOME_RECORD_ASSET.join(',')} FROM assets WHERE property_id=? ORDER BY install_date DESC`).bind(access.property_id).all(),
    DB.prepare(`SELECT ${HOME_RECORD_EVENT.join(',')} FROM service_events WHERE property_id=? AND status='completed' ORDER BY service_date DESC`).bind(access.property_id).all(),
    DB.prepare(`SELECT ${HOME_RECORD_OPPORTUNITY.join(',')} FROM opportunities WHERE property_id=? AND status='open' ORDER BY CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, estimated_value DESC`).bind(access.property_id).all()
  ]);
  return {
    access: { status: access.status, claimed_at: access.claimed_at, expires_at: access.expires_at },
    organization: pick(organization, HOME_RECORD_ORGANIZATION),
    homeowner: pick(homeowner, HOME_RECORD_HOMEOWNER),
    property: {
      id: access.property_id,
      address_line_1: access.address_line_1,
      address_line_2: access.address_line_2,
      city: access.city,
      state: access.state,
      postal_code: access.postal_code
    },
    assets: assets.results,
    serviceEvents: serviceEvents.results,
    opportunities: opportunities.results
  };
}

async function claimHomeRecord(DB, token) {
  const access = await loadHomeRecordAccess(DB, token);
  if (!access) return null;
  await DB.batch([
    DB.prepare("UPDATE home_record_access SET status='claimed', claimed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(access.id),
    DB.prepare("INSERT INTO interactions (id,organization_id,property_id,homeowner_id,type,direction,status,source) VALUES (?,?,?,?,'home_record_claimed','inbound','completed','home_record')")
      .bind(id('interaction'), access.organization_id, access.property_id, access.homeowner_id || null)
  ]);
  return { property_id: access.property_id, status: 'claimed' };
}

/** Books from the homeowner surface. Opportunity ids are re-scoped to this property. */
async function bookFromHomeRecord(DB, token, body = {}) {
  const access = await loadHomeRecordAccess(DB, token);
  if (!access) return null;
  const requestedId = clean(body.opportunity_id);
  const opportunity = requestedId
    ? await DB.prepare("SELECT * FROM opportunities WHERE id=? AND property_id=? AND status='open'").bind(requestedId, access.property_id).first()
    : await DB.prepare("SELECT * FROM opportunities WHERE property_id=? AND status='open' ORDER BY CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, estimated_value DESC LIMIT 1").bind(access.property_id).first();
  const bookingId = id('booking');
  const statements = [
    DB.prepare('INSERT INTO bookings (id,organization_id,property_id,homeowner_id,opportunity_id,scheduled_at,status,estimated_value) VALUES (?,?,?,?,?,?,?,?)')
      .bind(bookingId, access.organization_id, access.property_id, access.homeowner_id || null, opportunity?.id || null, clean(body.scheduled_at) || null, 'requested', num(opportunity?.estimated_value)),
    DB.prepare("INSERT INTO interactions (id,organization_id,property_id,homeowner_id,opportunity_id,type,direction,status,source,value) VALUES (?,?,?,?,?,'booking_request','inbound','completed','home_record',?)")
      .bind(id('interaction'), access.organization_id, access.property_id, access.homeowner_id || null, opportunity?.id || null, num(opportunity?.estimated_value))
  ];
  if (opportunity) {
    statements.splice(1, 0, DB.prepare("UPDATE opportunities SET status='booked', resolved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(opportunity.id));
  }
  await DB.batch(statements);
  return { booking_id: bookingId, opportunity_id: opportunity?.id || null };
}

/* ---------------------------------------------------------------------------
 * Demo account seeding
 *
 * The Northwest Heating & Air account is generated server-side so the dashboard
 * can read a real, refresh-stable account out of D1 instead of rebuilding a
 * throwaway workspace in the browser. Generation is deterministic apart from
 * the dates, which stay relative to "today" so the rules keep firing.
 * ------------------------------------------------------------------------- */

function hashString(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function seededRandom(seed) {
  let x = hashString(seed) || 123456789;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}

async function deleteOrganizationData(DB, organizationId) {
  await DB.batch([
    DB.prepare('DELETE FROM interactions WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM bookings WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM opportunities WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM home_record_access WHERE property_id IN (SELECT id FROM properties WHERE organization_id=?)').bind(organizationId),
    DB.prepare('DELETE FROM service_events WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM assets WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM properties WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM homeowners WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM visibility_snapshots WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM visibility_queries WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM automation_rules WHERE organization_id=?').bind(organizationId),
    DB.prepare('DELETE FROM organizations WHERE id=?').bind(organizationId)
  ]);
}

function demoStatements(DB) {
  const organizationId = DEMO_ORGANIZATION_ID;
  const firstNames = ['John','Sarah','Michael','Emily','Daniel','Rachel','Chris','Amanda','Ryan','Nicole','David','Lauren','Jason','Megan','Eric','Hannah','Matt','Jessica','Kevin','Brianna','Tyler','Olivia','Andrew','Kelsey','Brian','Samantha'];
  const lastNames = ['Smith','Walker','Torres','Nguyen','Johnson','Miller','Anderson','Martin','Thompson','Clark','Lee','Hall','Lewis','Young','Allen','King','Wright','Hill','Scott','Green','Baker','Adams','Nelson','Carter','Mitchell','Perez'];
  const streets = ['Main St','Cedar Ln','Birch Ct','Maple Dr','Holly St','Lakeway Dr','Sunset Ave','Northshore Rd','Alabama St','James St','Cornwall Ave','Meridian St','Yew St','Barkley Blvd','Orchard Pl'];
  const manufacturers = [['Trane','XR16'],['Carrier','Infinity 24'],['Lennox','EL18XCV'],['Mitsubishi','Hyper-Heat'],['Daikin','FIT'],['Bryant','Evolution'],['Rheem','RP15AZ']];
  const ageBuckets = [0.4, 1.1, 2.8, 5.5, 9.5, 13.2, 17.8];
  const rng = seededRandom('asktobooked-demo-2026');
  const statements = [];

  statements.push(DB.prepare('INSERT INTO organizations (id,name,slug,industry,city,state,service_area,phone,email,website,booking_url,average_job_value,monitoring_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(organizationId,'Northwest Heating & Air','northwest-heating-air','HVAC','Bellingham','WA','Whatcom County','(360) 555-0188','service@northwestheating.example','https://northwestheating.example','',4650,499));

  for (let i = 0; i < 52; i++) {
    const homeownerId = `nwha_homeowner_${i + 1}`, propertyId = `nwha_property_${i + 1}`, assetId = `nwha_asset_${i + 1}`;
    const first = firstNames[i % firstNames.length];
    const last = lastNames[(i * 7) % lastNames.length];
    const streetNo = 100 + ((i * 37) % 890);
    const street = streets[i % streets.length];
    const city = i % 7 === 0 ? 'Ferndale' : i % 9 === 0 ? 'Lynden' : 'Bellingham';
    const postal = city === 'Ferndale' ? '98248' : city === 'Lynden' ? '98264' : '98225';
    const address = `${streetNo} ${street}`;
    const email = `${first}.${last}.${i + 1}@example.com`.toLowerCase();
    const contactStatus = i % 17 === 0 ? 'transactional_only' : 'consented';
    const equipmentAge = ageBuckets[i % ageBuckets.length] + (rng() * 0.8);
    const installDate = new Date(Date.now() - equipmentAge * 365.25 * DAY);
    const [manufacturer, model] = manufacturers[i % manufacturers.length];
    const installAmount = Math.round((7200 + rng() * 7500) / 50) * 50;
    const category = i % 4 === 0 ? 'Furnace' : 'Heat Pump';
    const ageDays = Math.floor((Date.now() - installDate.getTime()) / DAY);

    statements.push(DB.prepare('INSERT INTO homeowners (id,organization_id,first_name,last_name,email,phone,contact_status,marketing_opt_in_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(homeownerId, organizationId, first, last, email, `(360) 555-${String(1000 + i).slice(-4)}`, contactStatus, contactStatus === 'consented' ? daysAgo(200 + i).toISOString() : null, installDate.toISOString()));

    statements.push(DB.prepare('INSERT INTO properties (id,organization_id,homeowner_id,address_line_1,city,state,postal_code,normalized_address,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(propertyId, organizationId, homeownerId, address, city, 'WA', postal, normalizeAddress(address, city, 'WA', postal), installDate.toISOString()));

    statements.push(DB.prepare('INSERT INTO assets (id,organization_id,property_id,category,manufacturer,model,serial_number,install_date,warranty_expiration,estimated_lifespan_years,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(assetId, organizationId, propertyId, category, manufacturer, model, `NW${2026 - Math.floor(equipmentAge)}${String(i + 1).padStart(4, '0')}`, dateOnly(installDate), dateOnly(new Date(installDate.getTime() + 3650 * DAY)), 15, installDate.toISOString()));

    statements.push(DB.prepare('INSERT INTO service_events (id,organization_id,property_id,homeowner_id,asset_id,type,service_date,description,amount,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(`nwha_event_install_${i + 1}`, organizationId, propertyId, homeownerId, assetId, 'installation', dateOnly(installDate), `${manufacturer} ${model} ${category.toLowerCase()} installation`, installAmount, 'completed', installDate.toISOString()));

    if (equipmentAge > 1.2 && i % 3 !== 1) {
      const maintenanceAgo = Math.min(120 + ((i * 43) % 460), ageDays - 40);
      statements.push(DB.prepare('INSERT INTO service_events (id,organization_id,property_id,homeowner_id,asset_id,type,service_date,description,amount,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(`nwha_event_maint_${i + 1}`, organizationId, propertyId, homeownerId, assetId, 'maintenance', dateOnly(daysAgo(maintenanceAgo)), 'Annual HVAC maintenance', 249, 'completed', daysAgo(maintenanceAgo).toISOString()));
    }

    if (equipmentAge > 9 && i % 2 === 0) {
      const repairCount = equipmentAge > 15 ? 3 : 1 + (i % 2);
      for (let r = 0; r < repairCount; r++) {
        const ago = 110 + r * 190 + (i % 5) * 17;
        statements.push(DB.prepare('INSERT INTO service_events (id,organization_id,property_id,homeowner_id,asset_id,type,service_date,description,amount,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .bind(`nwha_event_repair_${i + 1}_${r + 1}`, organizationId, propertyId, homeownerId, assetId, 'repair', dateOnly(daysAgo(ago)), r === 0 ? 'No-heat diagnostic and repair' : 'HVAC component repair', 520 + r * 330 + (i % 4) * 95, 'completed', daysAgo(ago).toISOString()));
      }
    }

    if (i % 11 === 2 || i % 17 === 4) {
      const sentAgo = 9 + (i % 19);
      statements.push(DB.prepare('INSERT INTO service_events (id,organization_id,property_id,homeowner_id,asset_id,type,service_date,description,amount,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(`nwha_event_estimate_${i + 1}`, organizationId, propertyId, homeownerId, assetId, 'estimate', dateOnly(daysAgo(sentAgo)), 'System replacement estimate', Math.round((8500 + rng() * 5000) / 100) * 100, 'open', daysAgo(sentAgo).toISOString()));
    }

    if (i % 8 === 3) {
      const serviceAgo = 760 + ((i * 31) % 500);
      statements.push(DB.prepare('INSERT INTO service_events (id,organization_id,property_id,homeowner_id,asset_id,type,service_date,description,amount,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(`nwha_event_old_${i + 1}`, organizationId, propertyId, homeownerId, assetId, 'repair', dateOnly(daysAgo(serviceAgo)), 'Historical service call', 780 + (i % 5) * 120, 'completed', daysAgo(serviceAgo).toISOString()));
    }

    const claimed = i % 4 !== 0;
    statements.push(DB.prepare('INSERT INTO home_record_access (id,property_id,homeowner_id,token,status,claimed_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(`nwha_access_${i + 1}`, propertyId, homeownerId, `demo-${String(i + 1).padStart(3, '0')}-${hashString(propertyId).toString(36).slice(0, 6)}`, claimed ? 'claimed' : 'invited', claimed ? daysAgo(40 + (i % 90)).toISOString() : null, daysAgo(100 + (i % 300)).toISOString()));
  }

  [[56,58,71,4.1,34,12,7,18],[28,62,73,4.4,39,14,8,14],[3,54,72,4.6,41,15,3,13]].forEach(([ago,ai,local,conversion,leads,booked,reviews,response], index) => {
    statements.push(DB.prepare('INSERT INTO visibility_snapshots (id,organization_id,snapshot_date,ai_mention_rate,local_visibility,website_conversion,qualified_leads,booked_jobs,new_reviews,response_minutes) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(`nwha_vis_${index + 1}`, organizationId, dateOnly(daysAgo(ago)), ai, local, conversion, leads, booked, reviews, response));
  });

  [['best heat pump installer in Bellingham','ChatGPT','Missed','Barron Heating'],['HVAC company near me','Google AI','Mentioned','West Mechanical'],['emergency furnace repair Bellingham','Google Search','Mentioned','Barron Heating'],['heat pump installation Whatcom County','Perplexity','Missed','Barron Heating']].forEach(([queryText, platform, status, competitor], index) => {
    statements.push(DB.prepare('INSERT INTO visibility_queries (id,organization_id,query_text,platform,status,competitor) VALUES (?,?,?,?,?,?)')
      .bind(`nwha_query_${index + 1}`, organizationId, queryText, platform, status, competitor));
  });

  return statements;
}

async function markDemoRecoveries(DB, organizationId) {
  const opportunities = (await DB.prepare("SELECT * FROM opportunities WHERE organization_id=? AND type='maintenance_due' AND status='open' ORDER BY id LIMIT 4").bind(organizationId).all()).results;
  const statements = [];
  opportunities.forEach((opportunity, index) => {
    const value = num(opportunity.estimated_value);
    statements.push(DB.prepare("UPDATE opportunities SET status='won', actual_value=?, resolved_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(value, daysAgo(7 + index * 3).toISOString(), opportunity.id));
    statements.push(DB.prepare("INSERT INTO bookings (id,organization_id,property_id,homeowner_id,opportunity_id,scheduled_at,status,estimated_value,actual_value,created_at) VALUES (?,?,?,?,?,?,'completed',?,?,?)")
      .bind(id('booking'), organizationId, opportunity.property_id, opportunity.homeowner_id, opportunity.id, dateOnly(daysAgo(5 + index)), value, value, daysAgo(9 + index * 3).toISOString()));
    statements.push(DB.prepare("INSERT INTO interactions (id,organization_id,property_id,homeowner_id,opportunity_id,type,direction,status,source,value,occurred_at) VALUES (?,?,?,?,?,'booking_request','inbound','completed','home_record',?,?)")
      .bind(id('interaction'), organizationId, opportunity.property_id, opportunity.homeowner_id, opportunity.id, value, daysAgo(9 + index * 3).toISOString()));
  });
  if (statements.length) await DB.batch(statements);
}

/**
 * Provisions the demo contractor login and its membership. Without this the
 * seeded organization would exist with no user able to reach it, since access
 * now comes exclusively from organization_members.
 */
async function ensureDemoUser(DB, organizationId, password) {
  const email = DEMO_USER_EMAIL;
  let user = await DB.prepare('SELECT id FROM users WHERE email_normalized=?').bind(email).first();
  if (!user) {
    const userId = id('user');
    await DB.prepare('INSERT INTO users (id,email,email_normalized,name,password_hash) VALUES (?,?,?,?,?)')
      .bind(userId, email, email, 'Demo Owner', await hashPassword(password)).run();
    user = { id: userId };
  } else {
    await DB.prepare('UPDATE users SET password_hash=?, status=\'active\', updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(await hashPassword(password), user.id).run();
  }
  await DB.prepare("INSERT OR IGNORE INTO organization_members (id,organization_id,user_id,role) VALUES (?,?,?,'owner')")
    .bind(id('member'), organizationId, user.id).run();
  return email;
}

async function grantMembership(DB, organizationId, userId) {
  if (!userId) return;
  await DB.prepare("INSERT OR IGNORE INTO organization_members (id,organization_id,user_id,role) VALUES (?,?,?,'admin')")
    .bind(id('member'), organizationId, userId).run();
}

async function seedDemoOrganization(DB, { reset = false, password = DEMO_USER_PASSWORD, memberUserId = null } = {}) {
  const organizationId = DEMO_ORGANIZATION_ID;
  const existing = await getOrganization(DB, organizationId);
  if (existing && !reset) {
    await ensureAutomationRules(DB, organizationId);
    const demoUserEmail = await ensureDemoUser(DB, organizationId, password);
    await grantMembership(DB, organizationId, memberUserId);
    return { organization_id: organizationId, seeded: false, demo_user_email: demoUserEmail, ...(await accountTotals(DB, organizationId)) };
  }
  if (existing) await deleteOrganizationData(DB, organizationId);

  const statements = demoStatements(DB);
  for (let index = 0; index < statements.length; index += 40) await DB.batch(statements.slice(index, index + 40));

  await ensureAutomationRules(DB, organizationId);
  await recalculateOpportunities(DB, organizationId);
  await markDemoRecoveries(DB, organizationId);
  const demoUserEmail = await ensureDemoUser(DB, organizationId, password);
  await grantMembership(DB, organizationId, memberUserId);
  return { organization_id: organizationId, seeded: true, demo_user_email: demoUserEmail, ...(await accountTotals(DB, organizationId)) };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return fail('D1 binding DB is not configured. The static product still works in local-first mode.', 503);
  const url = new URL(request.url), path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, ''), method = request.method.toUpperCase();
  const segment = index => decodeURIComponent(path.split('/')[index]);
  try {
    assertSameOrigin(request, url);

    if (method === 'GET' && path === 'health') { await env.DB.prepare('SELECT 1 AS ok').first(); return json({ok:true,service:'asktobooked-api',database:'connected'}); }

    /* --- Unauthenticated: session lifecycle --------------------------- */

    if (method === 'POST' && path === 'auth/register') {
      if (String(env.ALLOW_SIGNUP ?? 'true') !== 'true') return fail('Self-serve signup is disabled in this environment.', 403);
      const { headers, data } = await registerUser(env.DB, await readBody(request), request, url);
      return json({ok:true,data}, 201, headers);
    }
    if (method === 'POST' && path === 'auth/login') {
      const { headers, data } = await loginUser(env.DB, await readBody(request), request, url);
      return json({ok:true,data}, 200, headers);
    }
    if (method === 'POST' && path === 'auth/logout') {
      const auth = await resolveSession(env.DB, request);
      if (auth) await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(auth.sessionId).run();
      return json({ok:true,data:{signed_out:true}}, 200, { 'set-cookie': sessionCookie('', url, 0) });
    }

    /* --- Homeowner surface: capability token, never a session ---------- */

    if (method === 'GET' && /^home-record\/[^/]+$/.test(path)) { const data=await homeRecord(env.DB,segment(1)); return data?json({ok:true,data}):fail('Home Record not found',404); }
    if (method === 'POST' && /^home-record\/[^/]+\/claim$/.test(path)) { const result=await claimHomeRecord(env.DB,segment(1)); return result?json({ok:true,data:result}):fail('Home Record not found',404); }
    if (method === 'POST' && /^home-record\/[^/]+\/book$/.test(path)) { const result=await bookFromHomeRecord(env.DB,segment(1),await readOptionalBody(request)); return result?json({ok:true,data:result}):fail('Home Record not found',404); }

    /* --- Demo seeding: environment-gated, never on by default --------- */

    if (method === 'POST' && path === 'demo/seed') {
      if (String(env.ALLOW_DEMO_SEED ?? 'false') !== 'true') return fail('Demo seeding is disabled in this environment.', 403);
      const b = await readOptionalBody(request);
      // Seeding from an authenticated dashboard also grants that user access,
      // so the account they just created is actually reachable by them.
      const seeder = await resolveSession(env.DB, request);
      return json({ok:true,data:await seedDemoOrganization(env.DB,{
        reset: bool(b.reset),
        password: clean(b.password) || clean(env.DEMO_PASSWORD) || DEMO_USER_PASSWORD,
        memberUserId: seeder ? seeder.user.id : null
      })});
    }

    /* --- Contractor dashboard: everything below requires a session ----- */

    const auth = await resolveSession(env.DB, request);

    if (method === 'GET' && path === 'auth/session') return json({ok:true,data:await sessionPayload(env.DB, requireSession(auth))});

    // Nothing past this point is reachable without a contractor session, so an
    // anonymous caller cannot probe which dashboard routes exist.
    requireSession(auth);

    if (method === 'GET' && path === 'organizations') {
      requireSession(auth);
      return json({ok:true,data:(await sessionPayload(env.DB, auth)).organizations});
    }
    if (method === 'PATCH' && /^organizations\/[^/]+$/.test(path)) {
      const organizationId = requireOrganization(auth, segment(1));
      const organization = await updateOrganization(env.DB, organizationId, await readBody(request));
      return organization?json({ok:true,data:organization}):fail('Organization not found',404);
    }

    if (method === 'GET' && path === 'bootstrap') {
      requireSession(auth);
      const slug = url.searchParams.get('slug');
      let requested = url.searchParams.get('organization_id');
      if (!requested && slug) {
        const row = await env.DB.prepare('SELECT id FROM organizations WHERE slug=?').bind(slug).first();
        if (!row) return fail('Organization not found', 404);
        requested = row.id;
      }
      // With no explicit target, fall back to the caller's own first membership
      // rather than to any hard-coded organization.
      if (!requested) requested = auth.organizationIds[0];
      if (!requested) return fail('This account is not a member of any organization', 404);
      const organizationId = requireOrganization(auth, requested);
      const data = await bootstrap(env.DB, organizationId);
      return data?json({ok:true,data}):fail('Organization not found',404);
    }

    if (method === 'GET' && path === 'homes') {
      const organizationId = requireOrganization(auth, url.searchParams.get('organization_id') || auth.organizationIds[0]);
      const r=await env.DB.prepare(`SELECT p.*,h.first_name,h.last_name,h.email,h.phone,h.contact_status,hra.status home_record_status,hra.token home_record_token,(SELECT COALESCE(SUM(se.amount),0) FROM service_events se WHERE se.property_id=p.id AND se.status='completed' AND se.type<>'estimate') lifetime_revenue,(SELECT MAX(se.service_date) FROM service_events se WHERE se.property_id=p.id AND se.status='completed') last_service FROM properties p LEFT JOIN homeowners h ON h.id=p.homeowner_id LEFT JOIN home_record_access hra ON hra.property_id=p.id WHERE p.organization_id=? ORDER BY last_service DESC`).bind(organizationId).all();
      return json({ok:true,data:r.results});
    }
    if (method === 'GET' && /^homes\/[^/]+$/.test(path)) {
      const propertyId=segment(1);
      const property=await scopedRow(env.DB,'SELECT * FROM properties WHERE id=?',propertyId,auth);
      if(!property)return fail('Home not found',404);
      const data=await bootstrap(env.DB,property.organization_id);
      return json({ok:true,data:{property,homeowner:data.homeowners.find(h=>h.id===property.homeowner_id),assets:data.assets.filter(a=>a.property_id===propertyId),serviceEvents:data.serviceEvents.filter(e=>e.property_id===propertyId),opportunities:data.opportunities.filter(o=>o.property_id===propertyId),homeRecordAccess:data.homeRecordAccess.find(a=>a.property_id===propertyId)}});
    }
    if (method === 'POST' && /^homes\/[^/]+\/home-record$/.test(path)) {
      const property=await scopedRow(env.DB,'SELECT * FROM properties WHERE id=?',segment(1),auth);
      if(!property)return fail('Home not found',404);
      const access=await ensureHomeRecordAccess(env.DB,property.id);
      return access?json({ok:true,data:access}):fail('Home not found',404);
    }

    if (method === 'GET' && path === 'opportunities') {
      const organizationId = requireOrganization(auth, url.searchParams.get('organization_id') || auth.organizationIds[0]);
      const status=url.searchParams.get('status')||'open';
      const r=await env.DB.prepare("SELECT * FROM opportunities WHERE organization_id=? AND (?='' OR status=?) ORDER BY estimated_value DESC").bind(organizationId,status,status).all();
      return json({ok:true,data:r.results});
    }
    if (method === 'POST' && path === 'opportunities/recalculate') {
      const organizationId = requireOrganization(auth, (await readBody(request)).organization_id);
      return json({ok:true,data:await recalculateOpportunities(env.DB,organizationId)});
    }
    if (method === 'POST' && /^opportunities\/[^/]+\/book$/.test(path)) {
      const opportunity=await scopedRow(env.DB,'SELECT * FROM opportunities WHERE id=?',segment(1),auth);
      if(!opportunity)return fail('Opportunity not found',404);
      return json({ok:true,data:await bookOpportunity(env.DB,opportunity.id,await readOptionalBody(request))});
    }
    if (method === 'POST' && /^opportunities\/[^/]+\/dismiss$/.test(path)) {
      const opportunity=await scopedRow(env.DB,'SELECT * FROM opportunities WHERE id=?',segment(1),auth);
      if(!opportunity)return fail('Opportunity not found',404);
      return json({ok:true,data:await dismissOpportunity(env.DB,opportunity.id,await readOptionalBody(request))});
    }

    if (method === 'PATCH' && /^automation-rules\/[^/]+$/.test(path)) {
      const rule=await scopedRow(env.DB,'SELECT * FROM automation_rules WHERE id=?',segment(1),auth);
      if(!rule)return fail('Automation rule not found',404);
      return json({ok:true,data:await setAutomationRule(env.DB,rule.id,await readOptionalBody(request))});
    }

    if (method === 'POST' && path === 'visibility/snapshots') {
      const b=await readBody(request);
      const organizationId = requireOrganization(auth, b.organization_id);
      return json({ok:true,data:await addVisibilitySnapshot(env.DB,organizationId,b)});
    }
    if (method === 'POST' && path === 'visibility/queries') {
      const b=await readBody(request);
      const organizationId = requireOrganization(auth, b.organization_id);
      const query=await addVisibilityQuery(env.DB,organizationId,b);
      return query?json({ok:true,data:query}):fail('query_text is required');
    }

    if (method === 'POST' && path === 'jobs/import') {
      const b=await readBody(request);
      const organizationId = requireOrganization(auth, b.organization_id);
      if(!Array.isArray(b.rows))return fail('rows[] is required');
      const organization=await getOrganization(env.DB,organizationId);
      if(!organization)return fail('Organization not found',404);
      return json({ok:true,data:await importJobs(env.DB,organizationId,b.rows)});
    }

    return fail('Route not found',404,{path,method});
  } catch (error) {
    if (error instanceof HttpError) return fail(error.message, error.status);
    console.error(error);
    return fail('API request failed',500,error instanceof Error ? error.message : String(error));
  }
}
