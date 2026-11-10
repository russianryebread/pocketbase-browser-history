migrate((app) => {
    let history;
    try { history = app.findCollectionByNameOrId("history"); }
    catch (_) { return; } // Fresh installs import pb_schema.json after the first start.

    const rule = '@request.auth.id != "" && (@request.auth.role = "parent" || @request.auth.email = user_email)';
    for (const name of ["history", "history_daily", "history_hourly_profile", "history_user_totals", "history_search_daily"]) {
        const col = app.findCollectionByNameOrId(name);
        col.listRule = rule;
        col.viewRule = rule;
        if (name === "history") {
            col.createRule = '@request.auth.id != "" && @request.auth.email = user_email';
            if (!col.fields.getByName("source_visit_id")) col.fields.add(new TextField({ name: "source_visit_id", max: 120 }));
            if (!col.fields.getByName("browser")) col.fields.add(new TextField({ name: "browser", max: 30 }));
            if (!col.fields.getByName("timezone_offset")) col.fields.add(new NumberField({ name: "timezone_offset", onlyInt: true, min: -840, max: 840 }));
            if (!col.indexes.some((i) => i.includes("idx_history_source_visit"))) {
                col.indexes.push("CREATE UNIQUE INDEX idx_history_source_visit ON history (user_id, source_visit_id) WHERE source_visit_id != ''");
            }
        }
        if (name === "history_hourly_profile") {
            app.db().newQuery("DELETE FROM history_hourly_profile").execute();
            if (!col.fields.getByName("visit_date")) col.fields.add(new DateField({ name: "visit_date", required: true }));
            if (!col.fields.getByName("domain")) col.fields.add(new TextField({ name: "domain", required: true }));
            col.indexes = col.indexes.filter((i) => !i.includes("idx_hh_unique") && !i.includes("idx_hh_user_date"));
            col.indexes.push("CREATE UNIQUE INDEX idx_hh_unique ON history_hourly_profile (visit_date, user_id, domain, hour)");
            col.indexes.push("CREATE INDEX idx_hh_user_date ON history_hourly_profile (user_id, visit_date DESC)");
        }
        if (name === "history_search_daily") {
            app.db().newQuery("DELETE FROM history_search_daily").execute();
            if (!col.fields.getByName("domain")) col.fields.add(new TextField({ name: "domain", required: true }));
            col.indexes = col.indexes.filter((i) => !i.includes("idx_hsd_unique"));
            col.indexes.push("CREATE UNIQUE INDEX idx_hsd_unique ON history_search_daily (visit_date, user_id, domain, search_query)");
        }
        app.save(col);
    }
    const state = app.findCollectionByNameOrId("system_state");
    let paused;
    try { paused = app.findFirstRecordByFilter("system_state", "key = 'rollup_paused'"); }
    catch (_) { paused = new Record(state); paused.set("key", "rollup_paused"); }
    paused.set("value", "true");
    app.save(paused);
});
