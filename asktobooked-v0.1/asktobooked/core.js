(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AskToBookedCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;
  const STORAGE_KEY = 'asktobooked_home_os_v01';
  const now = () => new Date();
  const iso = d => new Date(d).toISOString();
  const dateOnly = d => iso(d).slice(0, 10);
  const daysAgo = n => new Date(Date.now() - n * DAY);
  const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);
  const yearsBetween = (a, b = now()) => (new Date(b) - new Date(a)) / (365.25 * DAY);
  const daysBetween = (a, b = now()) => Math.floor((new Date(b) - new Date(a)) / DAY);
  const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));
  const uid = (prefix = 'id') => `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
  const title = s => String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function seeded(seed) {
    let x = hashString(seed) || 123456789;
    return () => {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }

  function normalizePhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  }

  function normalizeAddress(parts) {
    const raw = Array.isArray(parts) ? parts.filter(Boolean).join(' ') : String(parts || '');
    return raw
      .toLowerCase()
      .replace(/\b(street)\b/g, 'st')
      .replace(/\b(avenue)\b/g, 'ave')
      .replace(/\b(road)\b/g, 'rd')
      .replace(/\b(drive)\b/g, 'dr')
      .replace(/\b(lane)\b/g, 'ln')
      .replace(/\b(court)\b/g, 'ct')
      .replace(/\b(place)\b/g, 'pl')
      .replace(/\b(boulevard)\b/g, 'blvd')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }

  function defaultAutomationRules() {
    return [
      { id: 'rule_maintenance', name: 'Maintenance due', event: 'asset.service_due', enabled: true, description: 'Create an opportunity when HVAC equipment has not had maintenance in the last 330 days.', channel: 'Opportunity' },
      { id: 'rule_estimate', name: 'Open estimate follow-up', event: 'estimate.aged_7d', enabled: true, description: 'Flag estimates that remain open for at least seven days.', channel: 'Opportunity' },
      { id: 'rule_dormant', name: 'Dormant homeowner', event: 'relationship.dormant_24m', enabled: true, description: 'Surface paying customers with no completed service in 24 months.', channel: 'Opportunity' },
      { id: 'rule_replacement', name: 'Replacement window', event: 'asset.replacement_window', enabled: true, description: 'Surface aging equipment, prioritizing homes with repeated recent repairs.', channel: 'Opportunity' },
      { id: 'rule_continuity', name: 'Home Record invitation', event: 'job.completed', enabled: true, description: 'Flag recently completed jobs whose homeowner has not claimed a Home Record.', channel: 'Home Record' },
      { id: 'rule_membership', name: 'Membership opportunity', event: 'relationship.repeat_customer', enabled: true, description: 'Surface repeat customers who have no active maintenance membership recorded.', channel: 'Opportunity' }
    ];
  }

  function emptyState() {
    const created = iso(now());
    return {
      meta: { version: 1, created_at: created, updated_at: created, mode: 'local-first' },
      organization: {
        id: 'org_default', name: 'Your Home Service Company', slug: 'your-company', industry: 'HVAC',
        city: 'Bellingham', state: 'WA', service_area: 'Whatcom County', phone: '', email: '', website: '', booking_url: '',
        average_job_value: 4500, monitoring_fee: 399
      },
      homeowners: [], properties: [], assets: [], serviceEvents: [], opportunities: [], interactions: [], bookings: [], homeRecordAccess: [],
      automationRules: defaultAutomationRules(),
      visibility: { snapshots: [], queries: [] },
      audit: { acquisition: 0, conversion: 0, retention: 0, continuity: 0, notes: '' }
    };
  }

  function makeDemoState() {
    const state = emptyState();
    state.organization = {
      id: 'org_nwha', name: 'Northwest Heating & Air', slug: 'northwest-heating-air', industry: 'HVAC',
      city: 'Bellingham', state: 'WA', service_area: 'Whatcom County', phone: '(360) 555-0188', email: 'service@northwestheating.example',
      website: 'https://northwestheating.example', booking_url: '', average_job_value: 4650, monitoring_fee: 499
    };

    const firstNames = ['John','Sarah','Michael','Emily','Daniel','Rachel','Chris','Amanda','Ryan','Nicole','David','Lauren','Jason','Megan','Eric','Hannah','Matt','Jessica','Kevin','Brianna','Tyler','Olivia','Andrew','Kelsey','Brian','Samantha'];
    const lastNames = ['Smith','Walker','Torres','Nguyen','Johnson','Miller','Anderson','Martin','Thompson','Clark','Lee','Hall','Lewis','Young','Allen','King','Wright','Hill','Scott','Green','Baker','Adams','Nelson','Carter','Mitchell','Perez'];
    const streets = ['Main St','Cedar Ln','Birch Ct','Maple Dr','Holly St','Lakeway Dr','Sunset Ave','Northshore Rd','Alabama St','James St','Cornwall Ave','Meridian St','Yew St','Barkley Blvd','Orchard Pl'];
    const manufacturers = [
      ['Trane','XR16'],['Carrier','Infinity 24'],['Lennox','EL18XCV'],['Mitsubishi','Hyper-Heat'],['Daikin','FIT'],['Bryant','Evolution'],['Rheem','RP15AZ']
    ];
    const rng = seeded('asktobooked-demo-2026');
    const ageBuckets = [0.4, 1.1, 2.8, 5.5, 9.5, 13.2, 17.8];

    for (let i = 0; i < 52; i++) {
      const homeownerId = `homeowner_${i + 1}`;
      const propertyId = `property_${i + 1}`;
      const assetId = `asset_${i + 1}`;
      const first = firstNames[i % firstNames.length];
      const last = lastNames[(i * 7) % lastNames.length];
      const streetNo = 100 + ((i * 37) % 890);
      const street = streets[i % streets.length];
      const city = i % 7 === 0 ? 'Ferndale' : i % 9 === 0 ? 'Lynden' : 'Bellingham';
      const email = `${first}.${last}.${i + 1}@example.com`.toLowerCase();
      const contactStatus = i % 17 === 0 ? 'transactional_only' : 'consented';
      const equipmentAge = ageBuckets[i % ageBuckets.length] + (rng() * 0.8);
      const installDate = new Date(Date.now() - equipmentAge * 365.25 * DAY);
      const [manufacturer, model] = manufacturers[i % manufacturers.length];
      const installAmount = Math.round((7200 + rng() * 7500) / 50) * 50;

      state.homeowners.push({
        id: homeownerId, organization_id: state.organization.id, first_name: first, last_name: last,
        email, phone: `(360) 555-${String(1000 + i).slice(-4)}`, contact_status: contactStatus,
        marketing_opt_in_at: contactStatus === 'consented' ? iso(daysAgo(200 + i)) : null,
        marketing_opt_out_at: null, created_at: iso(installDate)
      });

      state.properties.push({
        id: propertyId, organization_id: state.organization.id, homeowner_id: homeownerId,
        address_line_1: `${streetNo} ${street}`, address_line_2: '', city, state: 'WA', postal_code: city === 'Ferndale' ? '98248' : city === 'Lynden' ? '98264' : '98225',
        normalized_address: normalizeAddress([streetNo, street, city, 'WA']), created_at: iso(installDate)
      });

      state.assets.push({
        id: assetId, organization_id: state.organization.id, property_id: propertyId, category: i % 4 === 0 ? 'Furnace' : 'Heat Pump',
        manufacturer, model, serial_number: `NW${2026 - Math.floor(equipmentAge)}${String(i + 1).padStart(4, '0')}`,
        install_date: dateOnly(installDate), warranty_expiration: dateOnly(addDays(installDate, 3650)), estimated_lifespan_years: 15,
        created_at: iso(installDate)
      });

      state.serviceEvents.push({
        id: `event_install_${i + 1}`, organization_id: state.organization.id, property_id: propertyId, homeowner_id: homeownerId, asset_id: assetId,
        type: 'installation', service_date: dateOnly(installDate), description: `${manufacturer} ${model} ${i % 4 === 0 ? 'furnace' : 'heat pump'} installation`,
        amount: installAmount, status: 'completed', created_at: iso(installDate)
      });

      const ageDays = daysBetween(installDate);
      if (equipmentAge > 1.2 && i % 3 !== 1) {
        const maintDaysAgo = 120 + ((i * 43) % 460);
        state.serviceEvents.push({
          id: `event_maint_${i + 1}`, organization_id: state.organization.id, property_id: propertyId, homeowner_id: homeownerId, asset_id: assetId,
          type: 'maintenance', service_date: dateOnly(daysAgo(Math.min(maintDaysAgo, ageDays - 40))), description: 'Annual HVAC maintenance', amount: 249,
          status: 'completed', created_at: iso(daysAgo(Math.min(maintDaysAgo, ageDays - 40)))
        });
      }

      if (equipmentAge > 9 && i % 2 === 0) {
        const repairCount = equipmentAge > 15 ? 3 : 1 + (i % 2);
        for (let r = 0; r < repairCount; r++) {
          const ago = 110 + r * 190 + (i % 5) * 17;
          const amount = 520 + r * 330 + (i % 4) * 95;
          state.serviceEvents.push({
            id: `event_repair_${i + 1}_${r + 1}`, organization_id: state.organization.id, property_id: propertyId, homeowner_id: homeownerId, asset_id: assetId,
            type: 'repair', service_date: dateOnly(daysAgo(ago)), description: r === 0 ? 'No-heat diagnostic and repair' : 'HVAC component repair', amount,
            status: 'completed', created_at: iso(daysAgo(ago))
          });
        }
      }

      if (i % 11 === 2 || i % 17 === 4) {
        const amount = Math.round((8500 + rng() * 5000) / 100) * 100;
        const sentAgo = 9 + (i % 19);
        state.serviceEvents.push({
          id: `event_estimate_${i + 1}`, organization_id: state.organization.id, property_id: propertyId, homeowner_id: homeownerId, asset_id: assetId,
          type: 'estimate', service_date: dateOnly(daysAgo(sentAgo)), description: 'System replacement estimate', amount,
          status: 'open', created_at: iso(daysAgo(sentAgo))
        });
      }

      if (i % 8 === 3) {
        const serviceAgo = 760 + ((i * 31) % 500);
        state.serviceEvents.push({
          id: `event_old_${i + 1}`, organization_id: state.organization.id, property_id: propertyId, homeowner_id: homeownerId, asset_id: assetId,
          type: 'repair', service_date: dateOnly(daysAgo(serviceAgo)), description: 'Historical service call', amount: 780 + (i % 5) * 120,
          status: 'completed', created_at: iso(daysAgo(serviceAgo))
        });
      }

      const claimed = i % 4 !== 0;
      state.homeRecordAccess.push({
        id: `access_${i + 1}`, property_id: propertyId, homeowner_id: homeownerId,
        token: `demo-${String(i + 1).padStart(3, '0')}-${hashString(propertyId).toString(36).slice(0, 6)}`,
        status: claimed ? 'claimed' : 'invited', claimed_at: claimed ? iso(daysAgo(40 + (i % 90))) : null,
        expires_at: null, created_at: iso(daysAgo(100 + (i % 300)))
      });
    }

    state.visibility.snapshots = [
      { id: 'vis_1', date: dateOnly(daysAgo(56)), ai: 58, local: 71, conv: 4.1, leads: 34, booked: 12, reviews: 7, response: 18 },
      { id: 'vis_2', date: dateOnly(daysAgo(28)), ai: 62, local: 73, conv: 4.4, leads: 39, booked: 14, reviews: 8, response: 14 },
      { id: 'vis_3', date: dateOnly(daysAgo(3)), ai: 54, local: 72, conv: 4.6, leads: 41, booked: 15, reviews: 3, response: 13 }
    ];
    state.visibility.queries = [
      { id: 'query_1', query: 'best heat pump installer in Bellingham', platform: 'ChatGPT', status: 'Missed', competitor: 'Barron Heating' },
      { id: 'query_2', query: 'HVAC company near me', platform: 'Google AI', status: 'Mentioned', competitor: 'West Mechanical' },
      { id: 'query_3', query: 'emergency furnace repair Bellingham', platform: 'Google Search', status: 'Mentioned', competitor: 'Barron Heating' },
      { id: 'query_4', query: 'heat pump installation Whatcom County', platform: 'Perplexity', status: 'Missed', competitor: 'Barron Heating' }
    ];

    state.opportunities = generateOpportunities(state);
    // Mark a few historical recoveries so the dashboard demonstrates attribution.
    const historical = state.opportunities.filter(o => o.type === 'maintenance_due').slice(0, 4);
    historical.forEach((o, idx) => {
      o.status = 'won';
      o.actual_value = o.estimated_value;
      o.resolved_at = iso(daysAgo(7 + idx * 3));
      state.bookings.push({ id: `booking_demo_${idx + 1}`, organization_id: state.organization.id, property_id: o.property_id, homeowner_id: o.homeowner_id, opportunity_id: o.id, scheduled_at: dateOnly(daysAgo(5 + idx)), status: 'completed', estimated_value: o.estimated_value, actual_value: o.estimated_value, created_at: iso(daysAgo(9 + idx * 3)) });
    });
    state.audit = calculateAudit(state);
    return touch(state);
  }

  function latestEvent(events, predicate = () => true) {
    return events.filter(predicate).sort((a, b) => new Date(b.service_date) - new Date(a.service_date))[0] || null;
  }

  function sum(arr, fn = x => x) { return arr.reduce((a, x) => a + Number(fn(x) || 0), 0); }

  function makeOpportunity({ state, property, homeowner, asset = null, source = null, type, title: oppTitle, reason, estimatedValue, dueDate, confidence = 'medium' }) {
    const sourceId = source ? source.id : '';
    const key = [type, property.id, asset ? asset.id : '', sourceId].join(':');
    const existing = state.opportunities.find(o => o.dedupe_key === key);
    return {
      id: existing?.id || uid('opp'), dedupe_key: key, organization_id: state.organization.id, property_id: property.id,
      homeowner_id: homeowner?.id || null, asset_id: asset?.id || null, source_service_event_id: sourceId || null,
      type, title: oppTitle, reason, estimated_value: Math.round(Number(estimatedValue || 0)), actual_value: existing?.actual_value || null,
      due_date: dueDate ? dateOnly(dueDate) : dateOnly(now()), confidence, status: existing?.status || 'open',
      created_at: existing?.created_at || iso(now()), resolved_at: existing?.resolved_at || null
    };
  }

  function generateOpportunities(state) {
    const generated = [];
    const completedStatuses = new Set(['won','booked','dismissed','lost']);
    const historical = (state.opportunities || []).filter(o => completedStatuses.has(o.status));

    for (const property of state.properties) {
      const homeowner = state.homeowners.find(h => h.id === property.homeowner_id);
      const assets = state.assets.filter(a => a.property_id === property.id);
      const events = state.serviceEvents.filter(e => e.property_id === property.id);
      const access = state.homeRecordAccess.find(a => a.property_id === property.id);
      const paidCompleted = events.filter(e => e.status === 'completed' && Number(e.amount) > 0 && e.type !== 'estimate');
      const lastPaid = latestEvent(paidCompleted);

      for (const asset of assets) {
        const assetEvents = events.filter(e => e.asset_id === asset.id && e.status === 'completed');
        const lastMaintOrInstall = latestEvent(assetEvents, e => ['maintenance','installation'].includes(e.type));
        const assetAge = asset.install_date ? yearsBetween(asset.install_date) : 0;
        const recentRepairs = assetEvents.filter(e => e.type === 'repair' && daysBetween(e.service_date) <= 730);

        if (lastMaintOrInstall && daysBetween(lastMaintOrInstall.service_date) >= 330) {
          const daysLate = daysBetween(lastMaintOrInstall.service_date) - 330;
          generated.push(makeOpportunity({
            state, property, homeowner, asset, source: lastMaintOrInstall, type: 'maintenance_due', title: 'Annual maintenance due',
            reason: `${title(asset.category)} last received recorded maintenance/service ${daysBetween(lastMaintOrInstall.service_date)} days ago.`,
            estimatedValue: 249, dueDate: addDays(new Date(lastMaintOrInstall.service_date), 365), confidence: daysLate > 120 ? 'high' : 'medium'
          }));
        }

        if (assetAge >= 12) {
          const repairSpend = sum(recentRepairs, e => e.amount);
          const high = recentRepairs.length >= 2 || assetAge >= 16;
          generated.push(makeOpportunity({
            state, property, homeowner, asset, source: recentRepairs[0] || null, type: 'replacement_window', title: 'Equipment entering replacement window',
            reason: `${asset.manufacturer || ''} ${asset.model || title(asset.category)} is ${assetAge.toFixed(1)} years old${recentRepairs.length ? ` with ${recentRepairs.length} repair${recentRepairs.length === 1 ? '' : 's'} totaling $${repairSpend.toLocaleString()} in the last 24 months` : ''}.`,
            estimatedValue: 10500, dueDate: now(), confidence: high ? 'high' : 'medium'
          }));
        }
      }

      const openEstimates = events.filter(e => e.type === 'estimate' && e.status === 'open' && daysBetween(e.service_date) >= 7);
      for (const estimate of openEstimates) {
        generated.push(makeOpportunity({
          state, property, homeowner, asset: assets.find(a => a.id === estimate.asset_id), source: estimate,
          type: 'open_estimate', title: `Open ${Number(estimate.amount || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} estimate`,
          reason: `Estimate has remained open for ${daysBetween(estimate.service_date)} days with no accepted booking recorded.`,
          estimatedValue: estimate.amount, dueDate: addDays(new Date(estimate.service_date), 7), confidence: 'high'
        }));
      }

      if (lastPaid && daysBetween(lastPaid.service_date) >= 730) {
        generated.push(makeOpportunity({
          state, property, homeowner, source: lastPaid, type: 'dormant_relationship', title: 'Dormant homeowner relationship',
          reason: `Previously paying homeowner has had no recorded completed service for ${Math.floor(daysBetween(lastPaid.service_date) / 30)} months.`,
          estimatedValue: Math.max(350, Math.round((Number(lastPaid.amount || 0) * 0.18) / 50) * 50), dueDate: now(), confidence: 'medium'
        }));
      }

      const mostRecentCompleted = latestEvent(paidCompleted);
      if (mostRecentCompleted && daysBetween(mostRecentCompleted.service_date) <= 120 && (!access || access.status !== 'claimed')) {
        generated.push(makeOpportunity({
          state, property, homeowner, source: mostRecentCompleted, type: 'continuity_gap', title: 'Homeowner relationship not retained',
          reason: 'A recent completed job exists, but the homeowner has not claimed a Home Record or persistent service relationship.',
          estimatedValue: 249, dueDate: now(), confidence: 'high'
        }));
      }

      if (paidCompleted.length >= 2 && !events.some(e => e.type === 'membership' && e.status === 'active')) {
        generated.push(makeOpportunity({
          state, property, homeowner, source: lastPaid, type: 'membership', title: 'Maintenance membership opportunity',
          reason: `This home has ${paidCompleted.length} completed paid service events but no active maintenance membership recorded.`,
          estimatedValue: 299, dueDate: now(), confidence: paidCompleted.length >= 3 ? 'high' : 'medium'
        }));
      }
    }

    const historicalKeys = new Set(historical.map(o => o.dedupe_key));
    const fresh = generated.filter(o => !historicalKeys.has(o.dedupe_key));
    return [...historical, ...fresh].sort((a, b) => opportunityPriority(b) - opportunityPriority(a));
  }

  function opportunityPriority(o) {
    const confidence = { high: 3, medium: 2, low: 1 }[o.confidence] || 1;
    const value = Math.log10(Math.max(10, Number(o.estimated_value || 0)));
    const overdue = Math.max(0, daysBetween(o.due_date));
    return confidence * 100 + value * 10 + Math.min(30, overdue / 10);
  }

  function lifetimeRevenue(state, propertyId) {
    return sum(state.serviceEvents.filter(e => e.property_id === propertyId && e.status === 'completed' && e.type !== 'estimate'), e => e.amount);
  }

  function propertySummary(state, property) {
    const homeowner = state.homeowners.find(h => h.id === property.homeowner_id) || {};
    const events = state.serviceEvents.filter(e => e.property_id === property.id);
    const last = latestEvent(events, e => e.status === 'completed');
    const openOpps = state.opportunities.filter(o => o.property_id === property.id && o.status === 'open').sort((a,b) => opportunityPriority(b) - opportunityPriority(a));
    const access = state.homeRecordAccess.find(a => a.property_id === property.id);
    return {
      ...property,
      homeowner_name: [homeowner.first_name, homeowner.last_name].filter(Boolean).join(' '),
      homeowner_email: homeowner.email || '', homeowner_phone: homeowner.phone || '', homeowner_contact_status: homeowner.contact_status || 'unknown',
      last_service: last?.service_date || null, last_service_type: last?.type || null, lifetime_revenue: lifetimeRevenue(state, property.id),
      next_need: openOpps[0]?.title || 'No immediate opportunity', next_need_value: openOpps[0]?.estimated_value || 0,
      open_opportunities: openOpps.length, home_record_status: access?.status || 'not_created', home_record_token: access?.token || null
    };
  }

  function homeDetail(state, propertyId) {
    const property = state.properties.find(p => p.id === propertyId);
    if (!property) return null;
    const homeowner = state.homeowners.find(h => h.id === property.homeowner_id) || null;
    return {
      property,
      homeowner,
      assets: state.assets.filter(a => a.property_id === propertyId),
      serviceEvents: state.serviceEvents.filter(e => e.property_id === propertyId).sort((a,b) => new Date(b.service_date) - new Date(a.service_date)),
      opportunities: state.opportunities.filter(o => o.property_id === propertyId).sort((a,b) => opportunityPriority(b) - opportunityPriority(a)),
      interactions: state.interactions.filter(i => i.property_id === propertyId).sort((a,b) => new Date(b.occurred_at) - new Date(a.occurred_at)),
      bookings: state.bookings.filter(b => b.property_id === propertyId),
      access: state.homeRecordAccess.find(a => a.property_id === propertyId) || null,
      lifetimeRevenue: lifetimeRevenue(state, propertyId)
    };
  }

  function dashboardMetrics(state) {
    const open = state.opportunities.filter(o => o.status === 'open');
    const recovered = state.opportunities.filter(o => ['booked','won'].includes(o.status));
    const homesUnderCare = state.properties.filter(p => {
      const hasOwner = !!state.homeowners.find(h => h.id === p.homeowner_id);
      const hasCompleted = state.serviceEvents.some(e => e.property_id === p.id && e.status === 'completed');
      return hasOwner && hasCompleted;
    }).length;
    const claimed = state.homeRecordAccess.filter(a => a.status === 'claimed').length;
    return {
      homesUnderCare,
      activeHomeowners: new Set(state.properties.map(p => p.homeowner_id).filter(Boolean)).size,
      identifiedOpportunity: sum(open, o => o.estimated_value),
      recoveredRevenue: sum(recovered, o => o.actual_value || o.estimated_value),
      openOpportunities: open.length,
      claimedRecords: claimed,
      continuityRate: state.properties.length ? Math.round((claimed / state.properties.length) * 1000) / 10 : 0,
      highConfidenceValue: sum(open.filter(o => o.confidence === 'high'), o => o.estimated_value)
    };
  }

  function calculateAudit(state) {
    const latest = [...state.visibility.snapshots].sort((a,b) => String(a.date).localeCompare(String(b.date))).at(-1);
    const m = dashboardMetrics(state);
    const acquisition = latest ? clamp((Number(latest.ai || 0) + Number(latest.local || 0)) / 2) : 0;
    const conversion = latest && latest.leads ? clamp((latest.booked / latest.leads) * 220) : 0;
    const reachable = state.homeowners.length ? state.homeowners.filter(h => !['invalid','unsubscribed'].includes(h.contact_status)).length / state.homeowners.length : 0;
    const claimed = state.properties.length ? m.claimedRecords / state.properties.length : 0;
    const future = state.properties.length ? new Set(state.opportunities.filter(o => ['open','booked','won'].includes(o.status)).map(o => o.property_id)).size / state.properties.length : 0;
    const continuity = clamp((claimed * 0.5 + future * 0.3 + reachable * 0.2) * 100);
    const won = sum(state.opportunities.filter(o => ['booked','won'].includes(o.status)), o => o.actual_value || o.estimated_value);
    const recoverable = sum(state.opportunities.filter(o => o.status === 'open' && o.confidence === 'high'), o => o.estimated_value);
    const retention = clamp(32 + (won / Math.max(1, won + recoverable)) * 48 + claimed * 20);
    return { acquisition: Math.round(acquisition), conversion: Math.round(conversion), retention: Math.round(retention), continuity: Math.round(continuity), notes: 'Score uses current account data. It is a diagnostic, not a guarantee of future revenue.' };
  }

  function getOpportunityBreakdown(state) {
    const map = {};
    state.opportunities.filter(o => o.status === 'open').forEach(o => {
      if (!map[o.type]) map[o.type] = { type: o.type, label: title(o.type), count: 0, value: 0 };
      map[o.type].count += 1;
      map[o.type].value += Number(o.estimated_value || 0);
    });
    return Object.values(map).sort((a,b) => b.value - a.value);
  }

  function ensureHomeRecord(state, propertyId) {
    const property = state.properties.find(p => p.id === propertyId);
    if (!property) throw new Error('Property not found');
    let access = state.homeRecordAccess.find(a => a.property_id === propertyId);
    if (!access) {
      access = { id: uid('access'), property_id: propertyId, homeowner_id: property.homeowner_id, token: `home-${hashString(propertyId + Date.now()).toString(36)}-${Math.random().toString(36).slice(2,7)}`, status: 'invited', claimed_at: null, expires_at: null, created_at: iso(now()) };
      state.homeRecordAccess.push(access);
    }
    touch(state);
    return access;
  }

  function claimHomeRecord(state, token) {
    const access = state.homeRecordAccess.find(a => a.token === token);
    if (!access) return null;
    access.status = 'claimed';
    access.claimed_at = iso(now());
    state.interactions.push({ id: uid('interaction'), organization_id: state.organization.id, property_id: access.property_id, homeowner_id: access.homeowner_id, opportunity_id: null, type: 'home_record_claimed', direction: 'inbound', status: 'completed', occurred_at: iso(now()) });
    state.audit = calculateAudit(state);
    touch(state);
    return access;
  }

  function markBooking(state, { propertyId, opportunityId = null, scheduledAt = null, actualValue = null, source = 'home_record' }) {
    let opp = opportunityId ? state.opportunities.find(o => o.id === opportunityId) : null;
    if (!opp) opp = state.opportunities.filter(o => o.property_id === propertyId && o.status === 'open').sort((a,b) => opportunityPriority(b)-opportunityPriority(a))[0] || null;
    const property = state.properties.find(p => p.id === propertyId);
    if (!property) throw new Error('Property not found');
    const value = Number(actualValue || opp?.estimated_value || 0);
    if (opp) {
      opp.status = 'booked';
      opp.resolved_at = iso(now());
      if (actualValue) opp.actual_value = Number(actualValue);
    }
    const booking = {
      id: uid('booking'), organization_id: state.organization.id, property_id: propertyId, homeowner_id: property.homeowner_id,
      opportunity_id: opp?.id || null, scheduled_at: scheduledAt || dateOnly(addDays(now(), 3)), status: 'requested', estimated_value: Number(opp?.estimated_value || 0), actual_value: actualValue ? Number(actualValue) : null, created_at: iso(now())
    };
    state.bookings.push(booking);
    state.interactions.push({
      id: uid('interaction'), organization_id: state.organization.id, property_id: propertyId, homeowner_id: property.homeowner_id, opportunity_id: opp?.id || null,
      type: 'booking_request', direction: 'inbound', status: 'completed', source, value, occurred_at: iso(now())
    });
    state.audit = calculateAudit(state);
    touch(state);
    return booking;
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    const src = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i], next = src[i + 1];
      if (quoted) {
        if (c === '"' && next === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else {
        if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
    if (!rows.length) return [];
    const headers = rows.shift().map(h => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    return rows.filter(r => r.some(v => String(v).trim())).map(r => Object.fromEntries(headers.map((h, i) => [h, String(r[i] || '').trim()])));
  }

  function importJobsCSV(state, text) {
    const rows = parseCSV(text);
    const before = { properties: state.properties.length, homeowners: state.homeowners.length, events: state.serviceEvents.length };
    let skipped = 0;
    for (const row of rows) {
      const first = row.first_name || row.firstname || row.customer_first_name || '';
      const last = row.last_name || row.lastname || row.customer_last_name || row.customer || row.name || '';
      const email = (row.email || row.customer_email || '').toLowerCase();
      const phone = row.phone || row.customer_phone || '';
      const address = row.address || row.address_line_1 || row.street_address || '';
      const city = row.city || state.organization.city || '';
      const region = row.state || row.region || state.organization.state || '';
      const zip = row.zip || row.postal_code || row.zip_code || '';
      const jobDate = row.job_date || row.service_date || row.date || dateOnly(now());
      const jobType = row.job_type || row.service || row.description || 'Service job';
      const amount = Number(String(row.amount || row.revenue || row.total || '0').replace(/[$,]/g, '')) || 0;
      if (!address) { skipped++; continue; }

      const normalized = normalizeAddress([address, city, region, zip]);
      let homeowner = email ? state.homeowners.find(h => (h.email || '').toLowerCase() === email) : null;
      if (!homeowner && phone) homeowner = state.homeowners.find(h => normalizePhone(h.phone) === normalizePhone(phone));
      if (!homeowner) {
        homeowner = { id: uid('homeowner'), organization_id: state.organization.id, first_name: first, last_name: last, email, phone, contact_status: 'unknown', marketing_opt_in_at: null, marketing_opt_out_at: null, created_at: iso(now()) };
        state.homeowners.push(homeowner);
      }

      let property = state.properties.find(p => p.organization_id === state.organization.id && p.normalized_address === normalized);
      if (!property) {
        property = { id: uid('property'), organization_id: state.organization.id, homeowner_id: homeowner.id, address_line_1: address, address_line_2: '', city, state: region, postal_code: zip, normalized_address: normalized, created_at: iso(now()) };
        state.properties.push(property);
        ensureHomeRecord(state, property.id);
      } else if (!property.homeowner_id) property.homeowner_id = homeowner.id;

      const event = {
        id: uid('event'), organization_id: state.organization.id, property_id: property.id, homeowner_id: homeowner.id, asset_id: null,
        type: /estimate|quote/i.test(jobType) ? 'estimate' : /maint|tune|service plan/i.test(jobType) ? 'maintenance' : /install|replace|replacement/i.test(jobType) ? 'installation' : /repair|diagnostic|no heat|no cool/i.test(jobType) ? 'repair' : 'service',
        service_date: dateOnly(new Date(jobDate)), description: jobType, amount, status: /estimate|quote/i.test(jobType) ? 'open' : 'completed', created_at: iso(now())
      };
      state.serviceEvents.push(event);

      if (event.type === 'installation') {
        const asset = {
          id: uid('asset'), organization_id: state.organization.id, property_id: property.id, category: /furnace/i.test(jobType) ? 'Furnace' : /ac|air conditioner/i.test(jobType) ? 'Air Conditioner' : 'Heat Pump',
          manufacturer: row.manufacturer || '', model: row.model || '', serial_number: row.serial_number || '', install_date: event.service_date,
          warranty_expiration: row.warranty_expiration || null, estimated_lifespan_years: Number(row.estimated_lifespan_years || 15), created_at: iso(now())
        };
        state.assets.push(asset);
        event.asset_id = asset.id;
      }
    }

    state.opportunities = generateOpportunities(state);
    state.audit = calculateAudit(state);
    touch(state);
    const metrics = dashboardMetrics(state);
    return {
      rows_received: rows.length, rows_skipped: skipped, jobs_imported: state.serviceEvents.length - before.events,
      new_homes: state.properties.length - before.properties, unique_homes: state.properties.length,
      new_homeowners: state.homeowners.length - before.homeowners, unique_homeowners: state.homeowners.length,
      opportunities_detected: state.opportunities.filter(o => o.status === 'open').length,
      estimated_opportunity_value: metrics.identifiedOpportunity
    };
  }

  function touch(state) { state.meta.updated_at = iso(now()); return state; }
  function save(state) { touch(state); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state; }
  function load() {
    try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  function reset() { try { localStorage.removeItem(STORAGE_KEY); } catch {} }

  function exportJSON(state) { return JSON.stringify(state, null, 2); }

  return {
    DAY, STORAGE_KEY, emptyState, makeDemoState, defaultAutomationRules, generateOpportunities, opportunityPriority,
    dashboardMetrics, calculateAudit, getOpportunityBreakdown, propertySummary, homeDetail, lifetimeRevenue,
    ensureHomeRecord, claimHomeRecord, markBooking, parseCSV, importJobsCSV, normalizeAddress, normalizePhone,
    dateOnly, daysAgo, addDays, yearsBetween, daysBetween, title, sum, touch, save, load, reset, exportJSON, uid
  };
});
