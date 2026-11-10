const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const NOW = Date.parse('2026-09-23T16:00:00.000Z');
const EMAIL = 'child@example.com';
const PAGE = 'https://example.com/page';
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function loadExtension(browserName, pages, { initialState, onBatch } = {}) {
  const state = {
    pocketbaseUrl: 'https://pb.example', authToken: 'token', userEmail: EMAIL,
    ...initialState
  };
  const batches = [];
  const saved = new Map();
  let onMessage;
  const api = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { onMessage = listener; } }
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    permissions: { contains: async () => true },
    storage: { local: {
      async get(keys) { return structuredClone(Object.fromEntries(keys.map((key) => [key, state[key]]))); },
      async set(values) { Object.assign(state, structuredClone(values)); },
    } },
    history: {
      async search({ startTime, endTime }) {
        return pages.filter(({ lastVisitTime }) => lastVisitTime >= startTime && lastVisitTime <= endTime);
      },
      async getVisits({ url }) { return pages.find((page) => page.url === url).visits; },
    },
  };
  const fetchMock = async (url, options) => {
    assert.equal(options.method, 'POST');
    if (url === state.pocketbaseUrl + '/api/collections/users/auth-refresh') {
      assert.equal(options.headers.Authorization, state.authToken);
      return response(200, { token: 'refreshed-token', record: { email: state.userEmail } });
    }
    assert.equal(url, state.pocketbaseUrl + '/api/batch');
    assert.equal(options.headers.Authorization, 'refreshed-token');
    assert.equal(options.headers['Content-Type'], 'application/json');
    const { requests } = JSON.parse(options.body);
    batches.push(requests);
    const error = await onBatch?.(requests, batches.length);
    if (error) return error;
    return response(200, requests.map(({ method, url, body }) => {
      assert.equal(method, 'POST');
      assert.equal(url, '/api/collections/history/records');
      const key = body.user_id + '/' + body.source_visit_id;
      const prior = saved.get(key);
      if (prior) return { status: 200, body: { id: prior.id, duplicate: true } };
      const record = { ...body, id: 'record-' + (saved.size + 1) };
      saved.set(key, record);
      return { status: 200, body: record };
    }));
  };
  class BrowserDate extends Date { static now() { return NOW; } }
  const code = fs.readFileSync(path.join(__dirname, '..', `pocketbase-history-${browserName}`, 'background.js'), 'utf8');
  const context = vm.createContext({
    browser: api, fetch: fetchMock, crypto: { randomUUID: () => 'device-1' }, Date: BrowserDate, URL, AbortSignal
  });
  vm.runInContext(code, context);
  const send = (message) => new Promise((resolve) => {
    assert.equal(onMessage(message, {}, resolve), true);
  });
  return { state, batches, saved, send, sync: () => send({ action: 'syncNow' }) };
}

function pageWithVisits(count) {
  return {
    url: PAGE, title: 'Example', lastVisitTime: NOW - 120000,
    visits: Array.from({ length: count }, (_, i) => ({
      visitId: String(i + 1), visitTime: NOW - 120000 - i * 3600000
    }))
  };
}

for (const browserName of ['firefox', 'chrome']) {
  test(`${browserName} batches individual visits and safely replays committed chunks`, async () => {
    const page = pageWithVisits(27);
    page.visits.push({ visitId: 'remote', visitTime: NOW - 300000, isLocal: false });
    const { state, batches, saved, sync } = loadExtension(browserName, [page], {
      onBatch: (_, attempt) => attempt === 2 && response(503, { message: 'Unavailable' })
    });

    const first = await sync();
    assert.equal(first.ok, false);
    assert.match(first.error, /HTTP 503/);
    assert.equal(saved.size, 25);
    assert.deepEqual(state.backfillRanges, [[0, NOW]]);
    assert.equal(state.lastSuccessAt, undefined);

    const retry = await sync();
    assert.equal(retry.ok, true);
    assert.equal(retry.uploaded, 2);
    assert.deepEqual(batches.map((batch) => batch.length), [25, 2, 25, 2]);
    assert.equal(saved.size, 27);
    assert.equal(state.backfillComplete, true);
    const date = new Date(page.visits[0].visitTime);
    assert.deepEqual(batches[0][0].body, {
      url: PAGE, title: 'Example', visit_time: date.toISOString(), visit_count: 1,
      user_email: EMAIL, user_id: 'device-1', source_visit_id: `${browserName}:1:${date.getTime()}`,
      browser: browserName, timezone_offset: date.getTimezoneOffset()
    });
  });

  test(`${browserName} distinguishes a reused browser visit ID`, async () => {
    const page = pageWithVisits(2);
    page.visits[1].visitId = page.visits[0].visitId;
    const { saved, sync } = loadExtension(browserName, [page]);
    assert.equal((await sync()).uploaded, 2);
    assert.equal(saved.size, 2);
  });

  test(`${browserName} preserves older visits to a URL revisited during import`, async () => {
    const page = pageWithVisits(2);
    const { saved, sync, batches } = loadExtension(browserName, [page], {
      initialState: { liveSince: NOW - 180000, backfillRanges: [[0, NOW - 240000]] }
    });
    assert.equal((await sync()).ok, true);
    assert.equal(saved.size, 2);
    assert.deepEqual(batches.map((batch) => batch.length), [2]);
  });

  test(`${browserName} reduces chunks to fit PocketBase limits`, async () => {
    const { batches, sync, saved } = loadExtension(browserName, [pageWithVisits(9)], {
      onBatch: (requests) => {
        if (requests.length > 4) {
          return response(400, { data: { requests: { code: 'validation_length_too_long', params: { max: 4 } } } });
        }
        if (requests.length > 2) return response(413);
      }
    });
    assert.equal((await sync()).uploaded, 9);
    assert.deepEqual(batches.map((batch) => batch.length), [9, 4, 2, 2, 2, 2, 1]);
    assert.equal(saved.size, 9);
  });

  test(`${browserName} keeps failed live ranges and backfill coverage pending`, async () => {
    const initialState = { liveSince: NOW - 180000, backfillRanges: [[0, NOW - 240000]], backfillCoveredUrls: {} };
    const { state, sync } = loadExtension(browserName, [pageWithVisits(2)], {
      initialState,
      onBatch: (_, attempt) => {
        if (attempt === 1) return response(403, { message: 'Batch requests are not allowed.' });
        if (attempt === 2) return response(400, {
          data: { requests: { 1: { response: { data: { title: { code: 'validation_length_too_long' } } } } } }
        });
        if (attempt === 3) return response(200, []);
      }
    });
    for (const error of [/Enable batch requests/, /Invalid fields: title/, /incomplete batch result/]) {
      assert.match((await sync()).error, error);
      assert.deepEqual(state.liveRanges, [[initialState.liveSince, NOW]]);
      assert.deepEqual(state.backfillCoveredUrls, {});
    }
    assert.equal((await sync()).uploaded, 2);
    assert.deepEqual(state.liveRanges, []);
    assert.equal(state.backfillComplete, true);
  });

  test(`${browserName} serializes sign-in with sync and preserves same-account progress`, async () => {
    let finishBatch;
    const pending = new Promise((resolve) => { finishBatch = resolve; });
    const { send, state, sync } = loadExtension(browserName, [pageWithVisits(1)], {
      onBatch: () => pending
    });
    const activeSync = sync();
    const config = { action: 'saveConfig', pocketbaseUrl: state.pocketbaseUrl, userEmail: EMAIL, authToken: 'new-token' };
    assert.equal((await send(config)).ok, false);
    finishBatch();
    assert.equal((await activeSync).ok, true);
    assert.equal((await send(config)).ok, true);
    assert.equal(state.lastSuccessAt, NOW);
    assert.equal(state.backfillComplete, true);
    assert.equal(state.authToken, 'new-token');

    assert.equal((await send({ ...config, userEmail: 'different@example.com' })).ok, true);
    assert.equal(state.liveSince, null);
    assert.equal(state.backfillComplete, false);
    assert.equal(state.lastSuccessAt, null);
  });
}
