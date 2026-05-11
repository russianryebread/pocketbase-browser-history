#!/usr/bin/env node
/* eslint-disable no-console */

// One-shot backfill: scan the entire `history` table, enrich each row
// (category/flagged/domain/search_query) and rebuild the four rollup
// collections from scratch. Safe to re-run — it deletes and rewrites.
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
const DEDUP = process.env.DEDUP !== "0";
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("Set PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD env vars.");
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

    await truncate("history_daily");
    await truncate("history_hourly_profile");
    await truncate("history_user_totals");
    await truncate("history_search_daily");
    console.log("Rollup tables truncated.");

    const daily = new Map();
    const hourly = new Map();
    const totals = new Map();
    const search = new Map();
    const seenDomains = new Map();
    const leaders = new Map(); // (user_id|url) -> { row, visitTimeMs, dailyKey, hourlyKey, searchKey }

    let page = 1;
    let processed = 0;
    let mergedCount = 0;
    let totalPages = 1;

    while (page <= totalPages) {
        const result = await pb.collection("history").getList(page, PAGE_SIZE, {
            sort: "+visit_time",
            fields: "id,url,title,visit_time,visit_count,user_email,user_id,duration,category,flagged,domain,path,query,protocol,search_query",
        });
        totalPages = result.totalPages;

        for (const row of result.items) {
            const info = classify(row.url || "");
            const query = extractSearchQuery(row.url || "");
            const visitTime = row.visit_time || row.created;
            const date = String(visitTime).substring(0, 10);
            const dt = new Date(visitTime);
            const weekday = dt.getUTCDay();
            const hour = dt.getUTCHours();
            const userId = row.user_id || "";
            const userEmail = row.user_email || "";
            const visitCount = Number(row.visit_count) || 1;
            const duration = Number(row.duration) || 0;

            // Dedup pass: same (user_id, url) within 10 min collapses into the leader.
            if (DEDUP) {
                const visitTimeMs = new Date(visitTime).getTime();
                const dKey = userId + "|" + (row.url || "");
                const leader = leaders.get(dKey);
                if (leader && (visitTimeMs - leader.visitTimeMs) <= DEDUP_WINDOW_MS) {
                    leader.row.visit_count = (Number(leader.row.visit_count) || 1) + visitCount;
                    if (UPDATE_HISTORY) {
                        try {
                            await pb.collection("history").update(leader.row.id, { visit_count: leader.row.visit_count });
                            await pb.collection("history").delete(row.id);
                        } catch (e) { console.warn("merge failed for", row.id, e.message); }
                    }
                    // Augment the leader's already-counted rollups with this row's weight.
                    const dEntry = daily.get(leader.dailyKey);
                    if (dEntry) {
                        dEntry.visit_count_sum += visitCount;
                        dEntry.duration_sum += duration;
                        if (visitTime > dEntry.last_visit) dEntry.last_visit = visitTime;
                    }
                    const hEntry = hourly.get(leader.hourlyKey);
                    if (hEntry) {
                        hEntry.visits += visitCount;
                        if (info.flagged) hEntry.flagged_visits += visitCount;
                    }
                    const tEntry = totals.get(userId);
                    if (tEntry) {
                        tEntry.total_visits += visitCount;
                        tEntry.total_duration += duration;
                        if (info.flagged) tEntry.total_flagged += visitCount;
                        if (visitTime > tEntry.last_seen) tEntry.last_seen = visitTime;
                    }
                    if (leader.searchKey) {
                        const sEntry = search.get(leader.searchKey);
                        if (sEntry) {
                            sEntry.count += visitCount;
                            if (visitTime > sEntry.last_seen) sEntry.last_seen = visitTime;
                        }
                    }
                    mergedCount += 1;
                    continue;
                }
            }

            // Optionally enrich raw history rows in place
            if (UPDATE_HISTORY) {
                const patch = {};
                if (!row.category) patch.category = info.category;
                if (!row.domain || row.domain !== info.domain) patch.domain = info.domain;
                if (!row.path) patch.path = info.path;
                if (!row.query && info.query) patch.query = info.query;
                if (!row.protocol) patch.protocol = info.protocol;
                if (row.flagged === undefined || row.flagged === null) patch.flagged = info.flagged;
                if (!row.search_query && query) patch.search_query = query;
                if (Object.keys(patch).length) {
                    try { await pb.collection("history").update(row.id, patch); }
                    catch (e) { console.warn("history update failed for", row.id, e.message); }
                }
            }

            const dailyKey = `${date}|${userId}|${info.domain}`;
            let d = daily.get(dailyKey);
            if (!d) {
                d = {
                    visit_date: date + " 00:00:00.000Z",
                    user_id: userId,
                    user_email: userEmail,
                    domain: info.domain,
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
            d.visits += 1;
            d.visit_count_sum += visitCount;
            d.duration_sum += duration;
            if (query) d.search_count += 1;
            if (visitTime > d.last_visit) d.last_visit = visitTime;
            if (visitTime < d.first_visit) d.first_visit = visitTime;

            const hourlyKey = `${userId}|${weekday}|${hour}`;
            let h = hourly.get(hourlyKey);
            if (!h) {
                h = { user_id: userId, user_email: userEmail, weekday, hour, visits: 0, flagged_visits: 0 };
                hourly.set(hourlyKey, h);
            }
            h.visits += 1;
            if (info.flagged) h.flagged_visits += 1;

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
            t.total_visits += 1;
            t.total_duration += duration;
            if (info.flagged) t.total_flagged += 1;
            if (query) t.total_searches += 1;
            if (visitTime > t.last_seen) t.last_seen = visitTime;
            if (visitTime < t.first_seen) t.first_seen = visitTime;
            if (!t.user_email && userEmail) t.user_email = userEmail;

            const seenKey = `${userId}|${info.domain}`;
            if (!seenDomains.has(seenKey)) {
                seenDomains.set(seenKey, true);
                t.unique_domains += 1;
            }

            const sKey = query ? `${date}|${userId}|${query}` : null;
            if (sKey) {
                let s = search.get(sKey);
                if (!s) {
                    s = {
                        visit_date: date + " 00:00:00.000Z",
                        user_id: userId, user_email: userEmail,
                        search_query: query, count: 0, last_seen: visitTime,
                    };
                    search.set(sKey, s);
                }
                s.count += 1;
                if (visitTime > s.last_seen) s.last_seen = visitTime;
            }

            // Register this row as a potential dedup leader for the next visit
            if (DEDUP) {
                const dKey = userId + "|" + (row.url || "");
                leaders.set(dKey, {
                    row,
                    visitTimeMs: new Date(visitTime).getTime(),
                    dailyKey,
                    hourlyKey,
                    searchKey: sKey,
                });
            }
        }

        // Periodically prune stale leaders to bound memory
        if (DEDUP && leaders.size > 50000) {
            const cutoffMs = Date.now() - DEDUP_WINDOW_MS;
            for (const [k, v] of leaders) {
                if (v.visitTimeMs < cutoffMs) leaders.delete(k);
            }
        }

        processed += result.items.length;
        console.log(`Page ${page}/${totalPages} — processed ${processed} rows (merged ${mergedCount}; daily=${daily.size}, hourly=${hourly.size}, totals=${totals.size}, search=${search.size})`);
        page += 1;
    }

    console.log(`Dedup merged ${mergedCount} rows. Flushing rollups...`);
    await flush("history_daily", Array.from(daily.values()));
    await flush("history_hourly_profile", Array.from(hourly.values()));
    await flush("history_user_totals", Array.from(totals.values()));
    await flush("history_search_daily", Array.from(search.values()));

    // Reset rollup cursor so the live cron picks up from now-onward only.
    try {
        const cursorVal = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString().replace("T", " ").replace("Z", "");
        const existing = await pb.collection("system_state").getFirstListItem('key="rollup_cursor"').catch(() => null);
        if (existing) await pb.collection("system_state").update(existing.id, { value: cursorVal });
        else await pb.collection("system_state").create({ key: "rollup_cursor", value: cursorVal });
        console.log(`Rollup cursor set to ${cursorVal}`);
    } catch (e) {
        console.warn("Could not write rollup cursor:", e.message);
    }
    console.log("Done.");
}

async function truncate(name) {
    let page = 1;
    while (true) {
        const r = await pb.collection(name).getList(page, 500, { fields: "id" });
        if (r.items.length === 0) break;
        await Promise.all(r.items.map((it) => pb.collection(name).delete(it.id)));
        if (r.items.length < 500) break;
    }
}

async function flush(name, rows) {
    let i = 0;
    for (const row of rows) {
        try { await pb.collection(name).create(row); }
        catch (e) { console.warn(`${name} create failed:`, e.message, row); }
        i += 1;
        if (i % FLUSH_BATCH === 0) console.log(`  ${name}: ${i}/${rows.length}`);
    }
    console.log(`  ${name}: ${i}/${rows.length} done`);
}

main().catch((e) => { console.error(e); process.exit(1); });
