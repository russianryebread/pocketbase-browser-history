const api = typeof browser !== 'undefined' ? browser : chrome;
const BROWSER_NAME = 'firefox';
const PAGE_SIZE = 1000;
const BATCH_SIZE = 25;
const REQUEST_TIMEOUT_MS = 20000;
let syncing = false;

api.runtime.onInstalled.addListener(() => { api.alarms.create('history-sync', { periodInMinutes: 1 }); });
api.runtime.onStartup.addListener(() => { api.alarms.create('history-sync', { periodInMinutes: 1 }); syncHistory(); });
api.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'history-sync') syncHistory(); });
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let action;
  if (message.action === 'syncNow') action = syncHistory();
  else if (message.action === 'saveConfig') action = saveConfig(message);
  else return;
  action.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function saveConfig({ pocketbaseUrl, userEmail, authToken }) {
  if (syncing) return { ok: false, error: 'Wait for the current sync to finish, then sign in again' };
  syncing = true;
  try {
    const prior = await api.storage.local.get(['userEmail', 'pocketbaseUrl']);
    const state = { pocketbaseUrl, userEmail, authToken, lastError: '' };
    if (prior.userEmail !== userEmail || prior.pocketbaseUrl !== pocketbaseUrl) {
      Object.assign(state, {
        userId: crypto.randomUUID(), liveSince: null, liveRanges: [], backfillRanges: [],
        backfillCoveredUrls: {}, backfillComplete: false, lastSuccessAt: null
      });
    }
    await api.storage.local.set(state);
    return { ok: true };
  } finally { syncing = false; }
}

async function syncHistory() {
  if (syncing) return { ok: false, error: 'A sync is already running' };
  syncing = true;
  try {
    const config = await api.storage.local.get(['pocketbaseUrl', 'authToken', 'userEmail', 'userId', 'liveSince', 'liveRanges', 'backfillRanges', 'backfillCoveredUrls']);
    if (!config.pocketbaseUrl || !config.authToken || !config.userEmail) throw new Error('Sign in and save a PocketBase URL first');
    const target = new URL(config.pocketbaseUrl);
    const permissionOrigin = `${target.protocol}//${target.hostname}/*`;
    if (!(await api.permissions.contains({ origins: [permissionOrigin] }))) throw new Error('PocketBase host permission is missing');
    if (!config.userId) {
      config.userId = crypto.randomUUID();
      await api.storage.local.set({ userId: config.userId });
    }
    const token = await refreshToken(config);
    config.batchSize = BATCH_SIZE;
    const now = Date.now();
    let liveSince = config.liveSince;
    let liveRanges = config.liveRanges || [];
    let backfillRanges = config.backfillRanges;
    if (liveSince == null) {
      liveSince = now;
      backfillRanges = [[0, now]];
    } else if (now > liveSince) {
      // Process pending live windows oldest first, even after a long outage.
      liveRanges.unshift([liveSince, now]);
      liveSince = now;
    }
    await api.storage.local.set({ liveSince, liveRanges, backfillRanges });
    let uploaded = 0;
    for (let i = 0; i < 4 && liveRanges.length; i++) uploaded += await processRange(liveRanges, false, config, token, 'liveRanges');
    if (backfillRanges && backfillRanges.length) uploaded += await processRange(backfillRanges, true, config, token, 'backfillRanges');
    await api.storage.local.set({ lastSuccessAt: Date.now(), lastError: '', backfillComplete: !backfillRanges?.length,
      ...(backfillRanges?.length ? {} : { backfillCoveredUrls: {} }) });
    return { ok: true, uploaded, backfillRemaining: backfillRanges?.length || 0 };
  } catch (error) {
    await api.storage.local.set({ lastError: error.message });
    return { ok: false, error: error.message };
  } finally { syncing = false; }
}

async function refreshToken(config) {
  const response = await fetch(`${config.pocketbaseUrl}/api/collections/users/auth-refresh`, {
    method: 'POST', headers: { Authorization: config.authToken }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (response.status === 401) throw new Error('Your PocketBase session has expired. Sign in again.');
  if (!response.ok) throw new Error(`PocketBase could not refresh your session (HTTP ${response.status})`);
  const auth = await response.json();
  if (!auth.token || auth.record?.email !== config.userEmail) throw new Error('PocketBase returned an unexpected account. Sign in again.');
  await api.storage.local.set({ authToken: auth.token });
  return auth.token;
}

async function processRange(ranges, fullHistory, config, token, storageKey) {
  const [start, end] = ranges[ranges.length - 1];
  const items = await api.history.search({ text: '', startTime: start, endTime: end, maxResults: PAGE_SIZE });
  if (items.length === PAGE_SIZE && end - start > 1) {
    const middle = Math.floor((start + end) / 2);
    ranges.pop();
    if (fullHistory) ranges.push([start, middle], [middle, end]);
    else ranges.push([middle, end], [start, middle]);
    await api.storage.local.set({ [storageKey]: ranges });
    return 0;
  }
  if (items.length === PAGE_SIZE) throw new Error('Too many history pages in one millisecond');
  let uploaded = 0;
  const coveredUrls = config.backfillCoveredUrls || {};
  let requests = [];
  for (const item of items) {
    if (!item.url || !/^https?:\/\//i.test(item.url)) continue;
    const includeOlder = fullHistory || (!!config.backfillRanges?.length && !coveredUrls[item.url]);
    const visits = await api.history.getVisits({ url: item.url });
    for (const visit of visits) {
      if (visit.isLocal === false || !Number.isFinite(visit.visitTime) || visit.visitTime > end) continue;
      if (!includeOlder && visit.visitTime < start) continue;
      if (typeof visit.visitId !== 'string' || !visit.visitId) throw new Error('The browser returned a visit without an ID');
      const visitTime = new Date(visit.visitTime);
      const body = {
        url: item.url, title: item.title || '', visit_time: visitTime.toISOString(),
        visit_count: 1, user_email: config.userEmail, user_id: config.userId,
        source_visit_id: `${BROWSER_NAME}:${visit.visitId}:${visitTime.getTime()}`, browser: BROWSER_NAME,
        timezone_offset: visitTime.getTimezoneOffset()
      };
      requests.push({ method: 'POST', url: '/api/collections/history/records', body });
      if (requests.length >= config.batchSize) {
        uploaded += await uploadBatch(requests, config, token);
        requests = [];
      }
    }
    if (includeOlder && !fullHistory) {
      coveredUrls[item.url] = true;
    }
  }
  uploaded += await uploadBatch(requests, config, token);
  ranges.pop();
  const progress = { [storageKey]: ranges };
  if (!fullHistory && config.backfillRanges?.length) {
    config.backfillCoveredUrls = coveredUrls;
    progress.backfillCoveredUrls = coveredUrls;
  }
  await api.storage.local.set(progress);
  return uploaded;
}

async function uploadBatch(requests, config, token) {
  let uploaded = 0;
  let offset = 0;
  while (offset < requests.length) {
    const chunk = requests.slice(offset, offset + config.batchSize);
    const response = await fetch(`${config.pocketbaseUrl}/api/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ requests: chunk }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const requestErrors = result?.data?.requests;
      const maxRequests = requestErrors?.params?.max;
      if (response.status === 400 && requestErrors?.code === 'validation_length_too_long'
          && Number.isInteger(maxRequests) && maxRequests > 0 && maxRequests < chunk.length) {
        config.batchSize = maxRequests;
        continue;
      }
      if (response.status === 413 && chunk.length > 1) {
        config.batchSize = Math.floor(chunk.length / 2);
        continue;
      }
      if (response.status === 403 && result?.message === 'Batch requests are not allowed.') {
        throw new Error('Enable batch requests in PocketBase under Settings → Application');
      }
      const failed = Object.values(requestErrors || {}).find((item) => item?.response)?.response;
      const fields = Object.keys(failed?.data || {});
      const detail = fields.length ? `Invalid fields: ${fields.join(', ')}` : (failed?.message || result?.message);
      throw new Error(`PocketBase batch upload failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
    }
    if (!Array.isArray(result) || result.length !== chunk.length ||
        result.some((item) => item?.status !== 200 || !item.body?.id)) {
      throw new Error('PocketBase returned an incomplete batch result');
    }
    uploaded += result.filter((item) => item.body.duplicate !== true).length;
    offset += chunk.length;
  }
  return uploaded;
}
