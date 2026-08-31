(() => {
  'use strict';
  const D = window.AskToBookedData;
  if (!D) throw new Error('AskToBooked failed to load');
  const $ = s => document.querySelector(s);
  const api = D.createApiClient();

  // Only same-origin paths are accepted, so a crafted ?next= cannot bounce a
  // freshly signed-in contractor off to another site.
  function safeNext() {
    const raw = new URLSearchParams(location.search).get('next') || 'dashboard.html';
    return /^\/?[\w./-]*(\?[^#]*)?(#.*)?$/.test(raw) && !raw.startsWith('//') ? raw : 'dashboard.html';
  }

  let mode = 'signin';
  let busy = false;

  function setMode(next) {
    mode = next;
    const creating = mode === 'create';
    $('#tabSignIn').classList.toggle('active', !creating);
    $('#tabCreate').classList.toggle('active', creating);
    $('#tabSignIn').setAttribute('aria-selected', String(!creating));
    $('#tabCreate').setAttribute('aria-selected', String(creating));
    $('#nameField').hidden = !creating;
    $('#companyField').hidden = !creating;
    $('#authSubmit').textContent = creating ? 'Create account' : 'Sign in';
    $('#authPassword').setAttribute('autocomplete', creating ? 'new-password' : 'current-password');
    $('#authHint').textContent = creating
      ? 'Creating an account also creates a new organization that only you can see. Passwords must be at least 12 characters.'
      : 'Use the account your organization was set up with.';
    $('#authError').hidden = true;
  }

  function showError(message) {
    const el = $('#authError');
    el.textContent = message;
    el.hidden = false;
  }

  $('#tabSignIn').onclick = () => setMode('signin');
  $('#tabCreate').onclick = () => setMode('create');

  $('#authForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    if (!email || !password) { showError('Enter your email and password.'); return; }

    busy = true;
    $('#authSubmit').disabled = true;
    $('#authError').hidden = true;
    try {
      if (mode === 'create') {
        await api.register({ email, password, name: $('#authName').value.trim(), organization_name: $('#authCompany').value.trim() });
      } else {
        await api.login(email, password);
      }
      location.replace(safeNext());
    } catch (error) {
      showError(error && error.message ? error.message : 'Sign in failed.');
    } finally {
      busy = false;
      $('#authSubmit').disabled = false;
    }
  });

  // An already-valid session should not have to sign in again.
  api.session().then(() => location.replace(safeNext())).catch(() => {});
})();
