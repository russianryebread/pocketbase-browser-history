/// <reference path="../pb_data/types.d.ts" />

// PocketBase JS-VM hooks for the browser-history pipeline.
//
// Each handler runs in an isolated Goja context, so we load the shared
// helpers via require() inside every callback. See pb_hooks/lib.js for
// the actual implementation.

// Bootstrap: seed domain_categories on first run if the table is empty.
onBootstrap((e) => {
    e.next();
    try {
        const lib = require(`${__hooks}/lib.js`);
        lib.seedDomainCategoriesIfEmpty();
    } catch (err) {
        console.log("seed skipped: " + err);
    }
});

// Phase A — enrich the row in-flight (synchronous, before save)
onRecordCreate((e) => {
    if (e.collection.name !== "history") {
        e.next();
        return;
    }
    const lib = require(`${__hooks}/lib.js`);
    lib.enrichRecord(e.record);
    e.next();
}, "history");

// Phase A.1 — after a flagged history row is committed, email the admin
// (once per domain per UTC day; see lib.notifyFlaggedHit for dedup detail).
onRecordAfterCreateSuccess((e) => {
    e.next();
    try {
        const lib = require(`${__hooks}/lib.js`);
        lib.notifyFlaggedHit(e.record);
    } catch (err) {
        console.log("[notify] hook error: " + err);
    }
}, "history");

// Phase B — every 10 minutes, dedup recent rows and update rollup tables
cronAdd("history-rollup", "*/10 * * * *", () => {
    const lib = require(`${__hooks}/lib.js`);
    lib.runRollupTick();
});

// Manual trigger: POST to /api/history/rollup to fire a tick immediately.
routerAdd("POST", "/api/history/rollup", (e) => {
    const lib = require(`${__hooks}/lib.js`);
    const result = lib.runRollupTick();
    return e.json(200, { ok: true, ts: new Date().toISOString(), ...result });
}, $apis.requireSuperuserAuth());

// Hourly cleanup: purge dev-only history (localhost, 127.0.0.1, 192.168.x.x,
// IPv6 loopback). Edit PRIVATE_HOST_FILTERS in pb_hooks/lib.js to extend.
cronAdd("history-purge-private", "15 * * * *", () => {
    const lib = require(`${__hooks}/lib.js`);
    lib.purgePrivateNetworkRecords();
});

routerAdd("POST", "/api/history/purge-private", (e) => {
    const lib = require(`${__hooks}/lib.js`);
    const result = lib.purgePrivateNetworkRecords();
    return e.json(200, { ok: true, ts: new Date().toISOString(), ...result });
}, $apis.requireSuperuserAuth());
