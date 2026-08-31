(() => {
  'use strict';
  const C = window.AskToBookedCore;
  const D = window.AskToBookedData;
  if (!C || !D) throw new Error('AskToBooked failed to load');
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const money = n => Number(n || 0).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
  const shortDate = d => d ? new Date(`${String(d).slice(0,10)}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
  const pct = n => `${Number(n || 0).toFixed(1)}%`;
  const oppLabel = type => ({maintenance_due:'Maintenance due',replacement_window:'Replacement window',open_estimate:'Open estimate',dormant_relationship:'Dormant relationship',continuity_gap:'Continuity gap',membership:'Membership opportunity'}[type] || C.title(type));

  const params = new URLSearchParams(location.search);
  const store = D.createStore({ core: C, organizationId: params.get('organization_id') || undefined });

  let state = null;
  let status = store.status;
  let busy = false;
  let redirectingToSignIn = false;

  function toast(message) {
    const el = $('#toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /** Serializes user-triggered mutations and turns thrown API errors into feedback. */
  async function guard(action, fn) {
    if (busy) return;
    busy = true;
    try { await fn(); }
    catch (error) { console.error(error); toast(`${action} failed: ${error.message}`); }
    finally { busy = false; }
  }

  function showView(id, updateHash = true) {
    if (!document.getElementById(id)) id = 'overview';
    $$('.view').forEach(v => v.classList.toggle('active', v.id === id));
    $$('.nav-link').forEach(n => n.classList.toggle('active', n.dataset.view === id));
    if (updateHash) history.replaceState(null, '', `#${id}`);
    window.scrollTo({top:0,behavior:'auto'});
  }

  function kpi(label, value, note = '') {
    return `<div class="kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
  }

  function renderConnection() {
    const main = $('#appMain');
    main.classList.toggle('state-loading', !!status.loading && !state);
    main.classList.toggle('state-empty', !!status.needsSeed);

    const dot = $('#dataModeDot');
    if (status.mode === 'remote') {
      dot.className = 'status-dot';
      $('#dataModeTitle').textContent = 'Connected to D1';
      $('#dataModeNote').textContent = store.organizationId;
    } else if (status.mode === 'local') {
      dot.className = status.readOnly ? 'status-dot bad' : 'status-dot warn';
      $('#dataModeTitle').textContent = status.readOnly ? 'Offline snapshot' : 'Local demo mode';
      $('#dataModeNote').textContent = status.readOnly ? 'Read-only until the backend returns' : 'Data persists in this browser only';
    } else {
      dot.className = 'status-dot warn';
      $('#dataModeTitle').textContent = 'Connecting…';
      $('#dataModeNote').textContent = 'Checking the backend';
    }

    const pill = $('#engineStatus');
    if (status.syncing) { pill.textContent = 'Saving to D1…'; pill.className = 'pill warn'; }
    else if (status.readOnly) { pill.textContent = 'Offline · read-only'; pill.className = 'pill warn'; }
    else if (status.mode === 'local') { pill.textContent = 'Offline · local data'; pill.className = 'pill warn'; }
    else { pill.textContent = 'Opportunity engine active'; pill.className = 'pill good'; }

    const message = status.error || status.warning;
    const banner = $('#appBanner');
    banner.className = `app-banner ${status.error ? 'error' : 'warn'}`;
    banner.hidden = !message;
    $('#appBannerTitle').textContent = status.error ? 'Backend error' : 'Offline mode';
    $('#appBannerMessage').textContent = message || '';

    $('#appEmpty').hidden = !status.needsSeed;
    $('#appEmptyOrg').textContent = store.organizationId || 'this account';

    const user = store.user;
    $('#sessionRow').hidden = !user;
    if (user) $('#sessionEmail').textContent = user.name || user.email;

    const organizations = store.organizations;
    const picker = $('#orgPicker');
    picker.hidden = organizations.length < 2;
    if (organizations.length > 1) {
      const markup = organizations.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
      if (picker.dataset.signature !== markup) { picker.innerHTML = markup; picker.dataset.signature = markup; }
      picker.value = store.organizationId || '';
    }
  }

  function renderHeader() {
    const o = state.organization;
    $('#businessTitle').textContent = o.name || 'Your business';
    $('#businessMeta').textContent = [o.industry, o.service_area || [o.city,o.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  }

  function renderOverview() {
    const m = C.dashboardMetrics(state);
    $('#heroContinuity').textContent = pct(m.continuityRate);
    $('#overviewKpis').innerHTML = [
      kpi('Homes Under Care', m.homesUnderCare.toLocaleString(), 'durable homeowner relationships'),
      kpi('Identified opportunity', money(m.identifiedOpportunity), `${m.openOpportunities} open opportunities`),
      kpi('Recovered revenue', money(m.recoveredRevenue), 'booked/won through tracked opportunities'),
      kpi('High-confidence value', money(m.highConfidenceValue), 'best near-term action queue')
    ].join('');

    const open = state.opportunities.filter(o => o.status === 'open').sort((a,b) => C.opportunityPriority(b)-C.opportunityPriority(a)).slice(0,5);
    const emptyMessage = state.properties.length
      ? 'No open opportunities. Run the engine to re-evaluate the installed base.'
      : 'No Homes in this account yet. Import historical jobs to create Homes Under Care.';
    $('#priorityOpportunities').innerHTML = open.length ? open.map(o => {
      const p = C.propertySummary(state, state.properties.find(x => x.id === o.property_id));
      return `<div class="opp-row"><div><h4>${esc(o.title)}</h4><p>${esc(p.address_line_1)} · ${esc(p.homeowner_name)}</p><div class="meta-row"><span class="tag ${esc(o.confidence)}">${esc(o.confidence)}</span><span class="tag">${esc(oppLabel(o.type))}</span></div></div><div class="opp-value"><strong>${money(o.estimated_value)}</strong><small>${o.due_date && C.daysBetween(o.due_date)>0 ? `${C.daysBetween(o.due_date)}d overdue` : 'actionable now'}</small><button class="text-btn" data-open-home="${esc(o.property_id)}">Open home</button></div></div>`;
    }).join('') : `<div class="muted">${esc(emptyMessage)}</div>`;

    const breakdown = C.getOpportunityBreakdown(state);
    $('#opportunityBreakdown').innerHTML = breakdown.length ? breakdown.map(b => `<div class="breakdown-row"><div><strong>${esc(oppLabel(b.type))}</strong><small>${b.count} home${b.count===1?'':'s'}</small></div><b>${money(b.value)}</b></div>`).join('') : '<div class="muted">No open opportunity types yet.</div>';
  }

  function renderHomes() {
    const summaries = state.properties.map(p => C.propertySummary(state,p));
    const m = C.dashboardMetrics(state);
    const avgLtv = summaries.length ? summaries.reduce((a,p)=>a+p.lifetime_revenue,0)/summaries.length : 0;
    $('#homeKpis').innerHTML = [
      kpi('Homes Under Care', m.homesUnderCare.toLocaleString()),
      kpi('Home Records claimed', m.claimedRecords.toLocaleString(), `${pct(m.continuityRate)} of homes`),
      kpi('Average home LTV', money(avgLtv)),
      kpi('Homes with open need', new Set(state.opportunities.filter(o=>o.status==='open').map(o=>o.property_id)).size.toLocaleString())
    ].join('');
    const q = ($('#homeSearch').value || '').toLowerCase().trim();
    const rows = summaries.filter(p => !q || [p.address_line_1,p.city,p.homeowner_name,p.homeowner_email,p.next_need].join(' ').toLowerCase().includes(q));
    const emptyMessage = state.properties.length ? 'No matching homes.' : 'No Homes in this account yet. Import a CSV to build the installed base.';
    $('#homesTable').innerHTML = rows.map(p => `<tr>
      <td><span class="address">${esc(p.address_line_1)}</span><span class="subline">${esc([p.city,p.state].filter(Boolean).join(', '))}</span></td>
      <td>${esc(p.homeowner_name || 'Unknown')}<span class="subline">${esc(p.homeowner_email)}</span></td>
      <td>${esc(shortDate(p.last_service))}<span class="subline">${esc(C.title(p.last_service_type || ''))}</span></td>
      <td><strong>${money(p.lifetime_revenue)}</strong></td>
      <td>${esc(p.next_need)}${p.next_need_value ? `<span class="subline">${money(p.next_need_value)}</span>`:''}</td>
      <td><span class="record-status ${esc(p.home_record_status)}">${esc(C.title(p.home_record_status))}</span></td>
      <td><button class="text-btn" data-open-home="${esc(p.id)}">Open</button></td>
    </tr>`).join('') || `<tr><td colspan="7" class="muted">${esc(emptyMessage)}</td></tr>`;
  }

  function renderOpportunities() {
    const typeSelect = $('#oppTypeFilter');
    const existing = typeSelect.value;
    const types = [...new Set(state.opportunities.map(o => o.type))].sort();
    typeSelect.innerHTML = '<option value="">All types</option>' + types.map(t => `<option value="${esc(t)}">${esc(oppLabel(t))}</option>`).join('');
    typeSelect.value = types.includes(existing) ? existing : '';

    const open = state.opportunities.filter(o => o.status === 'open');
    const booked = state.opportunities.filter(o => ['booked','won'].includes(o.status));
    $('#opportunityKpis').innerHTML = [
      kpi('Open value', money(C.sum(open,o=>o.estimated_value))),
      kpi('High confidence', money(C.sum(open.filter(o=>o.confidence==='high'),o=>o.estimated_value))),
      kpi('Open opportunities', open.length.toLocaleString()),
      kpi('Recovered / booked', money(C.sum(booked,o=>o.actual_value||o.estimated_value)))
    ].join('');

    const q = ($('#oppSearch').value || '').toLowerCase().trim();
    const type = $('#oppTypeFilter').value;
    const confidence = $('#oppConfidenceFilter').value;
    const oppStatus = $('#oppStatusFilter').value;
    const rows = state.opportunities
      .filter(o => !q || [o.title,o.reason,oppLabel(o.type)].join(' ').toLowerCase().includes(q))
      .filter(o => !type || o.type === type)
      .filter(o => !confidence || o.confidence === confidence)
      .filter(o => !oppStatus || o.status === oppStatus)
      .sort((a,b) => C.opportunityPriority(b)-C.opportunityPriority(a));

    const emptyMessage = state.opportunities.length ? 'No opportunities match these filters.' : 'No opportunities recorded yet. Import history, then run the engine.';
    $('#opportunityList').innerHTML = rows.length ? rows.map(o => {
      const p = state.properties.find(x => x.id === o.property_id);
      const s = p ? C.propertySummary(state,p) : null;
      return `<article class="opportunity-card ${esc(o.confidence)}"><div><div class="meta-row"><span class="tag ${esc(o.confidence)}">${esc(o.confidence)} confidence</span><span class="tag ${esc(o.status)}">${esc(o.status)}</span><span class="tag">${esc(oppLabel(o.type))}</span></div><h3>${esc(o.title)}</h3><p>${esc(o.reason)}</p>${s?`<p class="where">${esc(s.address_line_1)} · ${esc(s.homeowner_name)}</p>`:''}<div class="opportunity-actions"><button class="text-btn" data-open-home="${esc(o.property_id)}">Open Home</button>${o.status==='open'?`<button class="text-btn" data-book-opp="${esc(o.id)}">Mark booked</button><button class="text-btn" data-dismiss-opp="${esc(o.id)}">Dismiss</button>`:''}</div></div><div class="right"><strong>${money(o.estimated_value)}</strong><small>${o.due_date ? `due ${shortDate(o.due_date)}` : 'estimated opportunity'}</small></div></article>`;
    }).join('') : `<article class="card"><div class="muted">${esc(emptyMessage)}</div></article>`;
  }

  function renderAutomations() {
    $('#automationList').innerHTML = state.automationRules.length
      ? state.automationRules.map(r => `<article class="automation-card"><div class="automation-top"><div><div class="meta-row"><span class="tag">${esc(r.channel)}</span><span class="tag">${esc(r.event)}</span></div><h3>${esc(r.name)}</h3><p>${esc(r.description)}</p></div><label class="switch"><input type="checkbox" data-rule-toggle="${esc(r.id)}" ${r.enabled?'checked':''}><span class="slider"></span></label></div></article>`).join('')
      : '<article class="card"><div class="muted">No automation rules are configured for this account.</div></article>';
  }

  function latestVisibility() {
    return [...state.visibility.snapshots].sort((a,b)=>String(a.date).localeCompare(String(b.date))).at(-1) || null;
  }
  function renderVisibility() {
    const latest = latestVisibility();
    $('#visibilityKpis').innerHTML = [
      kpi('AI mention rate', latest ? pct(latest.ai) : '—'),
      kpi('Local visibility', latest ? pct(latest.local) : '—'),
      kpi('Qualified leads', latest ? String(latest.leads) : '—'),
      kpi('Booked jobs', latest ? String(latest.booked) : '—')
    ].join('');
    const rows = [...state.visibility.snapshots].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    $('#visibilityTable').innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>Date</th><th>AI</th><th>Local</th><th>Conversion</th><th>Leads</th><th>Booked</th><th>Reviews</th><th>Response</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(shortDate(r.date))}</td><td>${pct(r.ai)}</td><td>${pct(r.local)}</td><td>${pct(r.conv)}</td><td>${esc(r.leads)}</td><td>${esc(r.booked)}</td><td>${esc(r.reviews)}</td><td>${esc(r.response)}m</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No snapshots yet.</div>';
    $('#queryList').innerHTML = state.visibility.queries.length ? state.visibility.queries.map(q => `<div class="query-row"><h4>${esc(q.query)}</h4><p>${esc(q.platform)} · ${esc(q.status)}${q.competitor?` · ${esc(q.competitor)}`:''}</p></div>`).join('') : '<div class="muted">No tracked queries yet.</div>';
  }

  function renderAudit() {
    state.audit = C.calculateAudit(state);
    const a = state.audit;
    const score = Math.round((a.acquisition + a.conversion + a.retention + a.continuity) / 4);
    $('#overallAuditScore').textContent = `${score}/100`;
    const labels = [['Acquisition',a.acquisition],['Conversion',a.conversion],['Revenue retention',a.retention],['Homeowner continuity',a.continuity]];
    $('#auditBars').innerHTML = labels.map(([l,v]) => `<div class="audit-row"><span>${esc(l)}</span><div class="bar"><i style="width:${Math.max(1,Math.min(100,v))}%"></i></div><b>${v}</b></div>`).join('');
    const weakest = [...labels].sort((x,y)=>x[1]-y[1])[0];
    $('#auditHeadline').textContent = weakest[0] === 'Homeowner continuity' ? 'You can win homeowners, but the relationship weakens after the job.' : `${weakest[0]} is the clearest constraint right now.`;
    $('#auditExplanation').textContent = weakest[0] === 'Homeowner continuity'
      ? 'The business has real customer history and future service potential, but too many completed jobs still fail to become a durable Home Record and future-service relationship. That is the wedge asktobooked is designed to close.'
      : `The current account signals make ${weakest[0].toLowerCase()} the weakest of the four continuity dimensions. Fix that constraint without abandoning the rest of the home relationship loop.`;
  }

  function renderSettings() {
    const o = state.organization;
    const map = {setName:'name',setIndustry:'industry',setCity:'city',setState:'state',setServiceArea:'service_area',setPhone:'phone',setEmail:'email',setWebsite:'website',setBookingUrl:'booking_url',setAvgJob:'average_job_value',setFee:'monitoring_fee'};
    Object.entries(map).forEach(([id,key]) => { if (document.activeElement !== $('#'+id)) $('#'+id).value = o[key] ?? ''; });
    $('#settingsOrgId').textContent = store.organizationId;
    $('#settingsModeNote').textContent = status.mode === 'remote'
      ? 'This workspace reads and writes the D1 database through the Pages Function API. Browser storage only keeps a cached snapshot for offline display.'
      : 'The D1 API is not reachable, so this workspace is running against browser storage. Reconnect the backend to make changes durable.';
  }

  function renderAll() {
    renderConnection();
    if (!state || status.needsSeed) return;
    renderHeader(); renderOverview(); renderHomes(); renderOpportunities(); renderAutomations(); renderVisibility(); renderAudit(); renderSettings();
  }

  async function homeDialog(propertyId) {
    const access = await store.ensureHomeRecord(propertyId);
    const d = C.homeDetail(state, propertyId); if (!d) return;
    const p = d.property, h = d.homeowner || {};
    const open = d.opportunities.filter(o=>o.status==='open');
    const assets = d.assets.length ? d.assets.map(a => `<div class="detail-kpi"><span>${esc(`${a.manufacturer||''} ${a.model||C.title(a.category)}`.trim())}</span><strong>${esc(`${C.title(a.category)} · installed ${shortDate(a.install_date)}`)}</strong></div>`).join('') : '<div class="muted">No equipment recorded.</div>';
    const events = d.serviceEvents.slice(0,10).map(e => `<div class="timeline-item"><span>${esc(shortDate(e.service_date))}</span><div><strong>${esc(C.title(e.type))}</strong><div class="muted">${esc(e.description)}</div></div><b>${e.amount?money(e.amount):''}</b></div>`).join('');
    const opps = open.slice(0,6).map(o => `<div class="timeline-item"><span class="tag ${esc(o.confidence)}">${esc(o.confidence)}</span><div><strong>${esc(o.title)}</strong><div class="muted">${esc(o.reason)}</div></div><b>${money(o.estimated_value)}</b></div>`).join('') || '<div class="muted">No open opportunities.</div>';
    const recordLink = access ? `<a class="btn" href="home.html?token=${encodeURIComponent(access.token)}" target="_blank" rel="noopener">Open Home Record</a>` : '';
    $('#homeDialogBody').innerHTML = `<div class="dialog-shell"><div class="dialog-header"><div><div class="eyebrow">Home</div><h2>${esc(p.address_line_1)}</h2><p class="muted">${esc([p.city,p.state,p.postal_code].filter(Boolean).join(', '))}</p></div><button class="close-btn" data-close-dialog aria-label="Close">×</button></div><div class="detail-grid">
      <section class="detail-section"><h3>Homeowner</h3><div class="detail-kpi"><span>Name</span><strong>${esc([h.first_name,h.last_name].filter(Boolean).join(' ')||'Unknown')}</strong></div><div class="detail-kpi"><span>Email</span><strong>${esc(h.email||'—')}</strong></div><div class="detail-kpi"><span>Contact status</span><strong>${esc(C.title(h.contact_status||'unknown'))}</strong></div></section>
      <section class="detail-section"><h3>Relationship</h3><div class="detail-kpi"><span>Lifetime revenue</span><strong>${money(d.lifetimeRevenue)}</strong></div><div class="detail-kpi"><span>Home Record</span><strong>${esc(C.title(access?.status || 'not_created'))}</strong></div><div class="detail-kpi"><span>Open opportunities</span><strong>${open.length}</strong></div></section>
      <section class="detail-section wide"><h3>Equipment</h3>${assets}</section>
      <section class="detail-section wide"><h3>Open opportunities</h3><div class="timeline">${opps}</div></section>
      <section class="detail-section wide"><h3>Service history</h3><div class="timeline">${events||'<div class="muted">No history recorded.</div>'}</div></section>
    </div><div class="form-actions" style="margin-top:16px">${recordLink}${open[0]?`<button class="btn secondary" data-book-opp="${esc(open[0].id)}">Simulate booking from this home</button>`:''}</div></div>`;
    $('#homeDialog').showModal();
  }

  function closeDialogs(){ if ($('#homeDialog').open) $('#homeDialog').close(); if ($('#simpleDialog').open) $('#simpleDialog').close(); }

  function openSimpleDialog(kind) {
    let html = '';
    if (kind === 'visibility') html = `<div class="dialog-shell"><div class="dialog-header"><div><div class="eyebrow">Visibility</div><h2>Add snapshot</h2></div><button class="close-btn" value="cancel">×</button></div><div class="form-grid" style="margin-top:16px"><label>Date<input name="date" type="date" required value="${C.dateOnly(new Date())}"></label><label>AI mention rate<input name="ai" type="number" min="0" max="100" value="50"></label><label>Local visibility<input name="local" type="number" min="0" max="100" value="70"></label><label>Website conversion %<input name="conv" type="number" step=".1" min="0" value="4"></label><label>Qualified leads<input name="leads" type="number" min="0" value="0"></label><label>Booked jobs<input name="booked" type="number" min="0" value="0"></label><label>New reviews<input name="reviews" type="number" min="0" value="0"></label><label>Response minutes<input name="response" type="number" min="0" value="15"></label></div><div class="form-actions" style="margin-top:16px"><button class="btn" value="save" data-dialog-save="visibility">Save snapshot</button></div></div>`;
    if (kind === 'query') html = `<div class="dialog-shell"><div class="dialog-header"><div><div class="eyebrow">Visibility</div><h2>Add buyer question</h2></div><button class="close-btn" value="cancel">×</button></div><div class="form-grid" style="margin-top:16px"><label class="wide">Buyer question<input name="query" required placeholder="best heat pump installer near me"></label><label>Platform<select name="platform"><option>ChatGPT</option><option>Google AI</option><option>Perplexity</option><option>Google Search</option><option>Maps</option></select></label><label>Result<select name="status"><option>Mentioned</option><option>Missed</option><option>Unknown</option></select></label><label class="wide">Competitor appearing instead<input name="competitor"></label></div><div class="form-actions" style="margin-top:16px"><button class="btn" value="save" data-dialog-save="query">Save question</button></div></div>`;
    $('#simpleDialogBody').innerHTML = html; $('#simpleDialog').showModal();
  }

  function handleDialogSave(kind, form) {
    const d = Object.fromEntries(new FormData(form).entries());
    $('#simpleDialog').close();
    guard('Save', async () => {
      if (kind === 'visibility') await store.addVisibilitySnapshot({ date:d.date, ai:Number(d.ai||0), local:Number(d.local||0), conv:Number(d.conv||0), leads:Number(d.leads||0), booked:Number(d.booked||0), reviews:Number(d.reviews||0), response:Number(d.response||0) });
      if (kind === 'query') await store.addVisibilityQuery({ query:d.query, platform:d.platform, status:d.status, competitor:d.competitor||'' });
      toast('Saved.');
    });
  }

  function runEngine() {
    guard('Recalculation', async () => {
      await store.recalculateOpportunities();
      toast(`Engine complete: ${state.opportunities.filter(o=>o.status==='open').length} open opportunities.`);
    });
  }

  document.addEventListener('click', e => {
    const nav = e.target.closest('[data-view]'); if (nav) { showView(nav.dataset.view); return; }
    const jump = e.target.closest('[data-jump]'); if (jump) { showView(jump.dataset.jump); return; }
    const home = e.target.closest('[data-open-home]'); if (home) { guard('Open home', () => homeDialog(home.dataset.openHome)); return; }
    const close = e.target.closest('[data-close-dialog]'); if (close) { closeDialogs(); return; }
    const book = e.target.closest('[data-book-opp]'); if (book) {
      const opportunityId = book.dataset.bookOpp;
      const opportunity = state && state.opportunities.find(o => o.id === opportunityId);
      closeDialogs();
      guard('Booking', async () => {
        await store.bookOpportunity(opportunityId);
        toast(`${money(opportunity && opportunity.estimated_value)} opportunity marked booked.`);
      });
      return;
    }
    const dismiss = e.target.closest('[data-dismiss-opp]'); if (dismiss) {
      guard('Dismiss', async () => { await store.dismissOpportunity(dismiss.dataset.dismissOpp); toast('Opportunity dismissed.'); });
      return;
    }
    const dialogSave = e.target.closest('[data-dialog-save]'); if (dialogSave) { e.preventDefault(); handleDialogSave(dialogSave.dataset.dialogSave, $('#simpleDialogForm')); return; }
  });

  document.addEventListener('change', e => {
    if (!e.target.matches('[data-rule-toggle]')) return;
    const toggle = e.target;
    const ruleId = toggle.dataset.ruleToggle;
    const enabled = toggle.checked;
    const rule = state && state.automationRules.find(r => r.id === ruleId);
    guard('Automation update', async () => {
      try { await store.setAutomationRuleEnabled(ruleId, enabled); }
      catch (error) { toggle.checked = !enabled; throw error; }
      toast(`${rule ? rule.name : 'Rule'} ${enabled ? 'enabled' : 'disabled'}.`);
    });
  });

  $('#homeSearch').addEventListener('input', () => { if (state) renderHomes(); });
  $('#oppSearch').addEventListener('input', () => { if (state) renderOpportunities(); });
  ['oppTypeFilter','oppConfidenceFilter','oppStatusFilter'].forEach(id => $('#'+id).addEventListener('change', () => { if (state) renderOpportunities(); }));
  $$('.nav-link').forEach(n => n.addEventListener('click', () => showView(n.dataset.view)));

  $('#recalcBtn').onclick = runEngine;
  $('#recalcBtn2').onclick = runEngine;
  $('#addVisibilityBtn').onclick = () => openSimpleDialog('visibility');
  $('#addQueryBtn').onclick = () => openSimpleDialog('query');
  $('#printAuditBtn').onclick = () => window.print();

  $('#loadDemoBtn').onclick = () => guard('Demo reload', async () => {
    if (store.mode === 'remote') {
      if (!confirm('Reseed the Northwest Heating & Air demo account in D1? This replaces that organization’s stored records.')) return;
      const result = await store.seedDemoOrganization({ reset: true });
      toast(`Demo account seeded in D1: ${result.unique_homes} homes.`);
    } else {
      if (!confirm('Replace the local workspace with the complete demo account?')) return;
      store.loadLocalDemo();
      toast('Local demo reloaded.');
    }
  });

  $('#seedDemoBtn').onclick = () => guard('Seeding', async () => {
    const result = await store.seedDemoOrganization({ reset: false });
    toast(`Demo account ready: ${result.unique_homes} homes.`);
  });

  $$('[data-retry]').forEach(button => button.addEventListener('click', () => guard('Reload', () => store.load())));
  $('#appBannerDismiss').onclick = () => { $('#appBanner').hidden = true; };

  $('#csvFile').addEventListener('change', async e => { const f=e.target.files?.[0]; if(f){$('#csvText').value=await f.text(); toast(`${f.name} loaded.`);} });
  $('#importBtn').onclick = () => guard('Import', async () => {
    const text = $('#csvText').value.trim();
    if (!text) { toast('Choose or paste a CSV first.'); return; }
    const r = await store.importCSV(text);
    $('#importTitle').textContent = 'Import complete';
    $('#importResult').innerHTML = [
      ['Rows received', r.rows_received], ['Jobs imported', r.jobs_imported], ['Rows skipped', r.rows_skipped],
      ['New homes', r.new_homes], ['New homeowners', r.new_homeowners], ['Homes in account', r.unique_homes],
      ['Open opportunities', r.open_opportunities], ['Estimated opportunity', money(r.estimated_opportunity_value)]
    ].map(([l,v]) => `<div class="import-metric"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join('');
    toast('History imported and the Opportunity Engine recalculated.');
  });

  $('#saveSettingsBtn').onclick = () => guard('Settings save', async () => {
    await store.updateOrganization({
      name:$('#setName').value.trim(), industry:$('#setIndustry').value.trim(), city:$('#setCity').value.trim(), state:$('#setState').value.trim(),
      service_area:$('#setServiceArea').value.trim(), phone:$('#setPhone').value.trim(), email:$('#setEmail').value.trim(),
      website:$('#setWebsite').value.trim(), booking_url:$('#setBookingUrl').value.trim(),
      average_job_value:Number($('#setAvgJob').value||0), monitoring_fee:Number($('#setFee').value||0)
    });
    toast('Business settings saved.');
  });

  $('#exportBtn').onclick = () => {
    if (!state) return;
    const blob = new Blob([C.exportJSON(state)],{type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${state.organization.slug||'asktobooked'}-workspace.json`; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),500);
  };

  $('#resetBtn').onclick = () => guard('Reset', async () => {
    if (!confirm('Clear this browser’s cached and offline asktobooked data? Records stored in D1 are not affected.')) return;
    store.clearBrowserData();
    if (store.mode === 'remote') { await store.load(); toast('Browser cache cleared. Account reloaded from D1.'); }
    else { store.loadLocalDemo(); toast('Local workspace reset.'); }
  });

  $('#signOutBtn').onclick = () => guard('Sign out', () => store.signOut());

  $('#orgPicker').onchange = event => guard('Switch organization', () => store.selectOrganization(event.target.value));

  $('#homeDialog').addEventListener('click',e=>{if(e.target===$('#homeDialog'))$('#homeDialog').close()});
  $('#simpleDialog').addEventListener('click',e=>{if(e.target===$('#simpleDialog'))$('#simpleDialog').close()});

  // Keeps long-lived tabs consistent with what another session may have written.
  window.addEventListener('focus', () => {
    if (store.mode !== 'remote' || status.syncing || status.loading || busy) return;
    if ($('#homeDialog').open || $('#simpleDialog').open) return;
    const last = status.lastSyncedAt ? Date.parse(status.lastSyncedAt) : 0;
    if (Date.now() - last < 30000) return;
    store.refresh().catch(error => console.error(error));
  });

  store.subscribe((nextState, nextStatus) => {
    state = nextState;
    status = nextStatus;
    // A dashboard with no session has nothing to render; hand the browser to
    // the sign-in page and come back to whatever was being viewed.
    if (status.unauthenticated && !redirectingToSignIn) {
      redirectingToSignIn = true;
      location.replace(`login.html?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
      return;
    }
    renderAll();
  });
  showView((location.hash || '#overview').slice(1), false);
  store.load();
})();
