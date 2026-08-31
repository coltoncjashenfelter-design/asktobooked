(() => {
  'use strict';
  const C = window.AskToBookedCore;
  const D = window.AskToBookedData;
  if (!C || !D) throw new Error('AskToBooked failed to load');
  const root = document.querySelector('#homeRecordRoot');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const money = n => Number(n || 0).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
  const shortDate = d => d ? new Date(`${String(d).slice(0,10)}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';

  const token = new URLSearchParams(location.search).get('token') || null;
  const store = D.createHomeRecordStore({ core: C, token });
  let busy = false;

  function toast(message) {
    const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function guard(action, fn) {
    if (busy) return;
    busy = true;
    try { await fn(); }
    catch (error) { console.error(error); toast(`${action} failed: ${error.message}`); }
    finally { busy = false; }
  }

  function panel(title, body) {
    return `<div class="home-card"><div class="empty-state"><h2>${esc(title)}</h2><p>${esc(body)}</p></div></div>`;
  }

  function render(record, status) {
    if (status.loading && !record) { root.innerHTML = panel('Loading your Home Record', 'Fetching your property, equipment, and service history.'); return; }
    if (status.error) { root.innerHTML = `${panel('We could not load this Home Record', status.error)}<div class="form-actions" style="margin-top:12px"><button class="btn" id="retryBtn">Try again</button></div>`; document.querySelector('#retryBtn').onclick = () => store.load(); return; }
    if (!record) { root.innerHTML = panel('Home Record not found', 'This link is invalid or the record is no longer available.'); return; }

    const property = record.property, homeowner = record.homeowner || {}, organization = record.organization || {};
    const open = [...record.opportunities].sort((a,b) => C.opportunityPriority(b) - C.opportunityPriority(a));
    const next = open[0] || null;
    const assets = record.assets.map(a => `<div class="asset-card"><strong>${esc(`${a.manufacturer||''} ${a.model||C.title(a.category)}`.trim())}</strong><span class="muted" style="font-size:11px">${esc(C.title(a.category))}</span><div class="asset-meta"><div>Installed<b>${esc(shortDate(a.install_date))}</b></div><div>Warranty<b>${a.warranty_expiration && C.daysBetween(a.warranty_expiration) < 0 ? 'Expired' : 'On record'}</b></div><div>Provider<b>${esc(organization.name)}</b></div></div></div>`).join('') || '<p class="muted">No equipment has been added yet.</p>';
    const history = record.serviceEvents.slice(0,10).map(e => `<div class="history-item"><span>${esc(shortDate(e.service_date))}</span><div><strong>${esc(C.title(e.type))}</strong><div class="muted">${esc(e.description)}</div></div><b>${e.amount?money(e.amount):''}</b></div>`).join('') || '<p class="muted">No service history yet.</p>';

    root.innerHTML = `<article class="home-card"><section class="home-hero"><div class="eyebrow light">My Home</div><h1>${esc(property.address_line_1)}</h1><p>${esc([property.city,property.state,property.postal_code].filter(Boolean).join(', '))}</p></section><div class="home-content">
      <section class="home-section"><div class="provider-badge">Maintained by</div><h2 style="font-size:17px;margin:3px 0 2px">${esc(organization.name)}</h2><p class="muted" style="font-size:11px;margin:0">${esc(organization.phone||organization.email||organization.service_area||'Your preferred provider')}</p></section>
      ${record.access.status !== 'claimed' ? `<section class="home-section"><div class="upcoming" style="background:#eef4f0;border-color:#d4e5da"><h3>Make this Home Record yours</h3><p>Claiming keeps this property’s service history and future maintenance record connected to you.</p><button class="book-btn" id="claimBtn" style="background:#2f7658">Claim Home Record</button></div></section>` : ''}
      <section class="home-section"><h2>Equipment</h2><div class="stack">${assets}</div></section>
      ${next ? `<section class="home-section"><h2>Coming up</h2><div class="upcoming"><div class="eyebrow">Recommended next</div><h3>${esc(next.title)}</h3><p>${esc(next.reason)}</p><button class="book-btn" id="bookBtn" data-opp="${esc(next.id)}">Book with ${esc(organization.name)}</button></div></section>` : ''}
      <section class="home-section"><h2>Service history</h2><div class="history-list">${history}</div></section>
      <section class="home-section"><h2>Documents</h2><div class="mini-row"><h4>Property documents</h4><p>Invoices, warranty files, equipment manuals, and service photos can live here once document storage is connected.</p></div></section>
      <section class="home-section"><p class="muted" style="font-size:10px;margin:0">asktobooked keeps the service relationship organized around the home. Marketing communication should only be sent when permitted by the homeowner’s contact preferences.${status.mode === 'local' ? ' This page is currently showing offline demo data.' : ''}</p></section>
    </div></article>`;

    const claimButton = document.querySelector('#claimBtn');
    if (claimButton) claimButton.onclick = () => guard('Claim', async () => { await store.claim(); toast('Home Record claimed.'); });

    const bookButton = document.querySelector('#bookBtn');
    if (bookButton) bookButton.onclick = () => guard('Booking', async () => {
      await store.book({ opportunityId: bookButton.dataset.opp });
      toast('Service request recorded.');
      if (organization.booking_url && /^https?:\/\//i.test(organization.booking_url)) setTimeout(() => window.open(organization.booking_url, '_blank', 'noopener'), 400);
    });
  }

  store.subscribe(render);
  store.load();
})();
