#!/usr/bin/env node
/* eslint-disable no-console */

// One-shot backfill: scan history and rebuild the four rollup collections.
// Safe to re-run: it pauses live rollups, then deletes and rewrites summaries.
//
// Usage:
//   POCKETBASE_URL=https://example.com \
//   PB_ADMIN_EMAIL=admin@example.com PB_ADMIN_PASSWORD=... \
//   node scripts/backfill_rollups.js
//
// Requires: PocketBase 0.22+ admin credentials (or superuser in 0.23+).
// Install dependency once: `npm i pocketbase`.

const PocketBase = require("pocketbase/cjs");
const path = require("path");

const URL_BASE = process.env.POCKETBASE_URL;
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
const PAGE_SIZE = Number(process.env.PAGE_SIZE) || 1000;
const FLUSH_BATCH = Number(process.env.FLUSH_BATCH) || 500;
const UPDATE_HISTORY = process.env.UPDATE_HISTORY !== "0";

if (!URL_BASE || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("Set POCKETBASE_URL, PB_ADMIN_EMAIL, and PB_ADMIN_PASSWORD.");
    process.exit(1);
}

// Load shared classifier from the dashboard module by re-execing it under
// a fake `window`. Keeps a single source of truth for the category map.
const fs = require("fs");
const sharedSrc = fs.readFileSync(
    path.join(__dirname, "..", "dashboard", "categories.js"),
    "utf8"
);
const fakeGlobal = {};
new Function("window", sharedSrc)(fakeGlobal);
const { classify, extractSearchQuery } = fakeGlobal.HistoryCategories;

const pb = new PocketBase(URL_BASE);

async function main() {
    console.log(`Connecting to ${URL_BASE}...`);
    try {
        await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
    } catch (e) {
        await pb.admins.authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
    }
    console.log("Auth OK.");
    await fakeGlobal.HistoryCategories.loadFromPB(pb);
    const { batch } = await pb.settings.getAll();
    const batchSize = batch?.enabled ? Math.min(25, batch.maxRequests) : 0;

    const cutoff = new Date().toISOString().replace("T", " ").replace("Z", "");
    await setState("rollup_paused", "true");
    for (const name of ["history_daily", "history_hourly_profile", "history_user_totals", "history_search_daily"]) {
        await pb.collections.truncate(name);
    }
    console.log("Rollup tables truncated.");

    const daily = new Map();
    const hourly = new Map();
    const totals = new Map();
    const search = new Map();
    const seenDomains = new Map();

    let lastId = "";
    let processed = 0;
    while (true) {
        const result = await pb.collection("history").getList(1, PAGE_SIZE, {
            filter: pb.filter('id > {:id} && created <= {:cutoff}', { id: lastId, cutoff }),
            sort: "+id",
            skipTotal: true,
            fields: "id,created,url,title,visit_time,visit_count,user_email,user_id,duration,timezone_offset,category,flagged,domain,path,query,protocol,search_query",
        });
        if (!result.items.length) break;

        for (const row of result.items) {
            const parsed = classify(row.url || "");
            const info = UPDATE_HISTORY
                ? parsed
                : { ...parsed, category: row.category || parsed.category, flagged: !!row.flagged };
            const domain = info.domain || row.domain || "(unknown)";
            const query = UPDATE_HISTORY
                ? extractSearchQuery(row.url || "")
                : row.search_query || extractSearchQuery(row.url || "");
            const visitTime = row.visit_time || row.created;
            const dt = new Date(new Date(visitTime).getTime() - (Number(row.timezone_offset) || 0) * 60000);
            const date = dt.toISOString().substring(0, 10);
            const weekday = dt.getUTCDay();
            const hour = dt.getUTCHours();
            const userId = row.user_id || "";
            const userEmail = row.user_email || "";
            const visitCount = Number(row.visit_count) || 1;
            const duration = Number(row.duration) || 0;

            // Optionally enrich raw history rows in place
            if (UPDATE_HISTORY) {
                const patch = {};
                if (row.category !== info.category) patch.category = info.category;
                if (!row.domain || row.domain !== info.domain) patch.domain = info.domain;
                if (!row.path) patch.path = info.path;
                if (!row.query && info.query) patch.query = info.query;
                if (!row.protocol) patch.protocol = info.protocol;
                if (!!row.flagged !== info.flagged) patch.flagged = info.flagged;
                if (row.search_query !== query) patch.search_query = query;
                if (Object.keys(patch).length) {
                    await pb.collection("history").update(row.id, patch);
                }
            }

            const dailyKey = `${date}|${userId}|${domain}`;
            let d = daily.get(dailyKey);
            if (!d) {
                d = {
                    visit_date: date + " 00:00:00.000Z",
                    user_id: userId,
                    user_email: userEmail,
                    domain,
                    category: info.category,
                    flagged: info.flagged,
                    visits: 0,
                    visit_count_sum: 0,
                    duration_sum: 0,
                    search_count: 0,
                    first_visit: visitTime,
                    last_visit: visitTime,
                };
                daily.set(dailyKey, d);
            }
            d.visits += visitCount;
            d.visit_count_sum += visitCount;
            d.duration_sum += duration;
            if (query) d.search_count += visitCount;
            if (visitTime > d.last_visit) d.last_visit = visitTime;
            if (visitTime < d.first_visit) d.first_visit = visitTime;

            const hourlyKey = `${date}|${userId}|${domain}|${hour}`;
            let h = hourly.get(hourlyKey);
            if (!h) {
                h = { visit_date: date + " 00:00:00.000Z", user_id: userId, user_email: userEmail, domain, weekday, hour, visits: 0, flagged_visits: 0 };
                hourly.set(hourlyKey, h);
            }
            h.visits += visitCount;
            if (info.flagged) h.flagged_visits += visitCount;

            let t = totals.get(userId);
            if (!t) {
                t = {
                    user_id: userId, user_email: userEmail,
                    total_visits: 0, total_duration: 0, total_flagged: 0,
                    total_searches: 0, unique_domains: 0,
                    first_seen: visitTime, last_seen: visitTime,
                };
                totals.set(userId, t);
            }
            t.total_visits += visitCount;
            t.total_duration += duration;
            if (info.flagged) t.total_flagged += visitCount;
            if (query) t.total_searches += visitCount;
            if (visitTime > t.last_seen) t.last_seen = visitTime;
            if (visitTime < t.first_seen) t.first_seen = visitTime;
            if (!t.user_email && userEmail) t.user_email = userEmail;

            const seenKey = `${userId}|${domain}`;
            if (!seenDomains.has(seenKey)) {
                seenDomains.set(seenKey, true);
                t.unique_domains += 1;
            }

            const sKey = query ? `${date}|${userId}|${domain}|${query}` : null;
            if (sKey) {
                let s = search.get(sKey);
                if (!s) {
                    s = {
                        visit_date: date + " 00:00:00.000Z",
                        user_id: userId, user_email: userEmail, domain,
                        search_query: query, count: 0, last_seen: visitTime,
                    };
                    search.set(sKey, s);
                }
                s.count += visitCount;
                if (visitTime > s.last_seen) s.last_seen = visitTime;
            }

        }

        processed += result.items.length;
        lastId = result.items[result.items.length - 1].id;
        console.log(`Through ${lastId} — processed ${processed} rows (daily=${daily.size}, hourly=${hourly.size}, totals=${totals.size}, search=${search.size})`);
    }

    console.log("Flushing rollups...");
    await flush("history_daily", Array.from(daily.values()), batchSize);
    await flush("history_hourly_profile", Array.from(hourly.values()), batchSize);
    await flush("history_user_totals", Array.from(totals.values()), batchSize);
    await flush("history_search_daily", Array.from(search.values()), batchSize);

    // Reset rollup cursor so the live cron picks up from now-onward only.
    try {
        const cursorVal = cutoff + "|";
        const existing = await pb.collection("system_state").getFirstListItem('key="rollup_cursor"').catch(() => null);
        if (existing) await pb.collection("system_state").update(existing.id, { value: cursorVal });
        else await pb.collection("system_state").create({ key: "rollup_cursor", value: cursorVal });
        console.log(`Rollup cursor set to ${cursorVal}`);
    } catch (e) {
        throw new Error("Could not write rollup cursor: " + e.message);
    }
    await setState("rollup_paused", "false");
    console.log("Done.");
}

async function setState(key, value) {
    const existing = await pb.collection("system_state").getFirstListItem(pb.filter('key = {:key}', { key })).catch(() => null);
    if (existing) await pb.collection("system_state").update(existing.id, { value });
    else await pb.collection("system_state").create({ key, value });
}

async function flush(name, rows, batchSize) {
    const chunkSize = batchSize || 1;
    let nextLog = FLUSH_BATCH;
    for (let i = 0; i < rows.length; i += chunkSize) {
        if (batchSize) {
            const batch = pb.createBatch();
            for (const row of rows.slice(i, i + chunkSize)) batch.collection(name).create(row);
            try {
                await batch.send();
            } catch (error) {
                const failures = Object.values(error.response?.data?.requests || {});
                const detail = failures.map(({ response }) => ({
                    message: response?.message,
                    fields: Object.fromEntries(Object.entries(response?.data || {}).map(([field, value]) => [field, value.code])),
                }));
                throw new Error(`Could not write ${name} rows ${i + 1}–${Math.min(i + chunkSize, rows.length)}: ${error.message} ${JSON.stringify(detail)}`);
            }
        } else {
            await pb.collection(name).create(rows[i]);
        }
        if (i + chunkSize >= nextLog) {
            console.log(`  ${name}: ${Math.min(i + chunkSize, rows.length)}/${rows.length}`);
            nextLog += FLUSH_BATCH;
        }
    }
    console.log(`  ${name}: ${rows.length}/${rows.length} done`);
}

main().catch((e) => { console.error(e); process.exit(1); });
