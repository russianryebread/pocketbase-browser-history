migrate((app) => {
    let hourly;
    try { hourly = app.findCollectionByNameOrId("history_hourly_profile"); }
    catch (_) { return; } // Fresh installs import the schema after startup.

    // PocketBase treats zero as empty for required numbers. Sunday and midnight are valid.
    hourly.fields.getByName("weekday").required = false;
    hourly.fields.getByName("hour").required = false;
    app.save(hourly);
});
