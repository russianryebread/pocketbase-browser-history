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
    const lib = require(`${__hooks}/lib.js`);
    lib.enrichRecord(e.record, e.app);
    e.next();
}, "history");

onRecordCreateRequest((e) => {
    if (!e.auth || e.auth.collection().name !== "users") {
        throw new ForbiddenError("Sign in to upload history");
    }
    const url = e.record.getString("url");
    const source = e.record.getString("source_visit_id");
    if (!/^https?:\/\//i.test(url) || !source) {
        throw new BadRequestError("A web URL and source visit ID are required");
    }
    const email = e.auth.getString("email");
    e.record.set("user_email", email);
    // Older clients stored only the browser's visit ID, which Firefox can reuse.
    const legacy = source.replace(/^((?:firefox|chrome):[^:]+):\d+$/, "$1");
    const [prior] = e.app.findRecordsByFilter(
        "history",
        "user_id = {:device} && user_email = {:email} && source_visit_id != ''" +
        " && (source_visit_id = {:source} || source_visit_id = {:legacy})" +
        " && (source_visit_id = {:source} || (visit_time = {:time} && url = {:url}))",
        "", 1, 0,
        { device: e.record.getString("user_id"), email, source, legacy, time: e.record.getString("visit_time"), url }
    );
    if (prior) return e.json(200, { id: prior.id, duplicate: true });
    e.next();
}, "history");

onRecordUpdateRequest((e) => {
    if (!e.hasSuperuserAuth()) {
        const old = e.app.findRecordById("users", e.record.id);
        if (e.record.getString("role") !== old.getString("role")) {
            throw new ForbiddenError("Only an administrator can change family roles");
        }
    }
    e.next();
}, "users");

onRecordCreateRequest((e) => {
    if (!e.hasSuperuserAuth() && e.record.getString("role") === "parent") {
        throw new ForbiddenError("Only an administrator can create parent accounts");
    }
    if (!e.record.getString("role")) e.record.set("role", "child");
    e.next();
}, "users");

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

// Phase B — every 10 minutes, update rollup tables from new rows
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
