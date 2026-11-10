const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'app.js'), 'utf8');
const context = vm.createContext({
  window: { localStorage: { getItem: () => null }, location: { origin: 'https://pb.example' } },
  HistoryCategories: { getHost: () => 'example.com', classify: () => ({ category: 'other' }) },
  Date, Set, Map, URL, console,
});
vm.runInContext(source, context);

test('short-range metrics count people once and use visit-device local time', () => {
  const app = vm.runInContext('dashboard()', context);
  app.rangePreset = '7d';
  app.historyRows = [
    { url: 'https://example.com/a', domain: 'example.com', visit_time: '2026-09-23T04:00:00Z', timezone_offset: 360, visit_count: 1, user_id: 'device-1', user_email: 'child@example.com', search_query: 'homework' },
    { url: 'https://example.com/b', domain: 'example.com', visit_time: '2026-09-23T05:00:00Z', timezone_offset: 360, visit_count: 1, user_id: 'device-2', user_email: 'child@example.com' },
  ];
  assert.equal(app.rangeDays, 7);
  assert.equal(app.kpis.activeUsers, 1);
  assert.equal(app.kpis.lateNight, 2);
  assert.equal(app.dailyTrend.labels[0], '2026-09-22');
  assert.equal(app.topSearches[0].count, 1);
});
