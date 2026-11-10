const api = typeof browser !== 'undefined' ? browser : chrome;
const $ = (id) => document.getElementById(id);

function status(message, error = false) {
  $('status').textContent = message;
  $('status').className = error ? 'error' : 'success';
}

async function refreshStatus() {
  const state = await api.storage.local.get(['pocketbaseUrl', 'userEmail', 'lastSuccessAt', 'lastError', 'backfillRanges', 'backfillCoveredUrls', 'backfillComplete']);
  $('pocketbaseUrl').value = state.pocketbaseUrl || '';
  $('userEmail').value = state.userEmail || '';
  if (state.lastError) status(state.lastError, true);
  else if (state.userEmail) status(`Signed in as ${state.userEmail}. Last sync: ${state.lastSuccessAt ? new Date(state.lastSuccessAt).toLocaleString() : 'pending'}. Initial import: ${state.backfillComplete ? 'complete' : `${state.backfillRanges?.length || 0} ranges remaining`}.`);
}

document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();
  $('saveConfig').addEventListener('click', async () => {
    try {
      const url = new URL($('pocketbaseUrl').value.trim());
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP on localhost');
      const base = url.origin;
      const granted = await api.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
      if (!granted) throw new Error('PocketBase host permission was denied');
      const response = await fetch(`${base}/api/collections/users/auth-with-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: $('userEmail').value.trim(), password: $('password').value })
      });
      if (!response.ok) throw new Error('Sign in failed; check the URL, email, and password');
      const auth = await response.json();
      if (!auth.token || !auth.record?.email) throw new Error('PocketBase returned an invalid sign-in response');
      const result = await api.runtime.sendMessage({
        action: 'saveConfig', pocketbaseUrl: base, userEmail: auth.record.email, authToken: auth.token
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not save PocketBase settings');
      $('password').value = '';
      status(`Signed in as ${auth.record.email}. Initial history import will begin on sync.`);
    } catch (error) { status(error.message, true); }
  });
  $('syncNow').addEventListener('click', async () => {
    status('Syncing…');
    try {
      const result = await api.runtime.sendMessage({ action: 'syncNow' });
      if (!result?.ok) throw new Error(result?.error || 'Sync failed');
      status(`Synced ${result.uploaded} visits. Initial import ranges remaining: ${result.backfillRemaining}.`);
    } catch (error) { status(error.message, true); }
  });
});
