/// <reference path="../pb_data/types.d.ts" />

// Shared helpers for the history hooks. PocketBase's JS-VM isolates each
// hook callback, so top-level functions defined in main.pb.js aren't
// visible inside cron/event handlers — everything has to be loaded via
// require() inside the handler closure.

const ROLLUP_CURSOR_KEY = "rollup_cursor";
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const SAFETY_BUFFER_MS = 60 * 1000;

const CATEGORIES = {
    social: ["facebook.com","instagram.com","twitter.com","x.com","tiktok.com","snapchat.com","reddit.com","linkedin.com","pinterest.com","threads.net","bsky.app","discord.com","discordapp.com","tumblr.com","mastodon.social","vk.com","weibo.com","quora.com"],
    video: ["youtube.com","youtu.be","m.youtube.com","twitch.tv","netflix.com","hulu.com","disneyplus.com","primevideo.com","hbomax.com","max.com","peacocktv.com","vimeo.com","dailymotion.com","paramountplus.com","appletv.com","crunchyroll.com","funimation.com","tubitv.com","pluto.tv"],
    gaming: ["roblox.com","steampowered.com","steamcommunity.com","minecraft.net","epicgames.com","fortnite.com","ea.com","ubisoft.com","rockstargames.com","playstation.com","xbox.com","nintendo.com","curseforge.com","mojang.com","battle.net","blizzard.com","leagueoflegends.com","valorant.com","riotgames.com","ign.com","gamespot.com","kongregate.com","miniclip.com","poki.com","crazygames.com","y8.com"],
    news: ["cnn.com","foxnews.com","nytimes.com","bbc.com","bbc.co.uk","reuters.com","theguardian.com","washingtonpost.com","npr.org","apnews.com","bloomberg.com","wsj.com","usatoday.com","abcnews.go.com","nbcnews.com","cbsnews.com","huffpost.com","politico.com","axios.com","vox.com","economist.com"],
    adult: ["pornhub.com","xvideos.com","xnxx.com","redtube.com","xhamster.com","youporn.com","onlyfans.com","chaturbate.com","brazzers.com","manyvids.com","stripchat.com","livejasmin.com","tnaflix.com","eporner.com","spankbang.com","beeg.com","motherless.com","tube8.com","hentai-foundry.com","e-hentai.org","nhentai.net","rule34.xxx","fakku.net","literotica.com","fetlife.com","adultfriendfinder.com","ashleymadison.com"],
    education: ["khanacademy.org","duolingo.com","coursera.org","edx.org","codecademy.com","udemy.com","brilliant.org","ixl.com","prodigygame.com","quizlet.com","kahoot.com","kahoot.it","scratch.mit.edu","code.org","classroom.google.com","wikipedia.org","wikimedia.org","ck12.org","edmodo.com","schoology.com","canvas.instructure.com","blackboard.com","freecodecamp.org","leetcode.com","hackerrank.com"],
    shopping: ["amazon.com","ebay.com","etsy.com","walmart.com","target.com","bestbuy.com","homedepot.com","costco.com","aliexpress.com","temu.com","shein.com","wayfair.com","macys.com","kohls.com","nike.com","adidas.com","ikea.com","newegg.com","wish.com","groupon.com"],
    search: ["google.com","bing.com","duckduckgo.com","yahoo.com","ecosia.org","brave.com","search.brave.com","kagi.com","startpage.com","qwant.com"],
    productivity: ["github.com","gitlab.com","bitbucket.org","stackoverflow.com","stackexchange.com","notion.so","slack.com","trello.com","asana.com","atlassian.com","atlassian.net","monday.com","office.com","office365.com","microsoft.com","live.com","outlook.com","docs.google.com","drive.google.com","sheets.google.com","calendar.google.com","mail.google.com","dropbox.com","box.com","zoom.us","webex.com","figma.com","miro.com","loom.com"],
    ai: ["chatgpt.com","openai.com","claude.ai","anthropic.com","gemini.google.com","bard.google.com","perplexity.ai","copilot.microsoft.com","character.ai","you.com","huggingface.co","midjourney.com","runwayml.com"],
};

const HARDCODED_BY_DOMAIN = {};
const HARDCODED_FLAGGED = {};
for (const cat of Object.keys(CATEGORIES)) {
    for (const d of CATEGORIES[cat]) HARDCODED_BY_DOMAIN[d] = cat;
}
for (const d of CATEGORIES.adult) HARDCODED_FLAGGED[d] = true;

// DB overrides — loaded lazily and cached for the lifetime of this VM
// (each PocketBase hook callback runs in its own VM, so the cache is
// effectively per-handler-invocation).
let _domainOverrides = null;

function loadDomainOverrides() {
    if (_domainOverrides !== null) return _domainOverrides;
    try {
        const recs = $app.findAllRecords("domain_categories");
        const exact = {};
        const flaggedExact = {};
        const suffix = []; // sorted longest first for greedy match
        for (const r of recs) {
            const domain = r.getString("domain").toLowerCase();
            if (!domain) continue;
            const category = r.getString("category") || "other";
            const flagged = !!r.get("flagged");
            const matchType = r.getString("match_type") || "exact";
            if (matchType === "suffix") {
                suffix.push({ domain, category, flagged });
            } else {
                exact[domain] = category;
                if (flagged) flaggedExact[domain] = true;
            }
        }
        suffix.sort((a, b) => b.domain.length - a.domain.length);
        _domainOverrides = { exact, flaggedExact, suffix };
    } catch (e) {
        // Collection may not exist yet at first boot — fall back to hardcoded.
        _domainOverrides = { exact: {}, flaggedExact: {}, suffix: [] };
    }
    return _domainOverrides;
}

function lookupCategory(hostname) {
    if (!hostname) return { category: "other", flagged: false };
    const ov = loadDomainOverrides();
    if (ov.exact[hostname]) {
        return { category: ov.exact[hostname], flagged: !!ov.flaggedExact[hostname] };
    }
    const root = rootDomain(hostname);
    if (ov.exact[root]) {
        return { category: ov.exact[root], flagged: !!ov.flaggedExact[root] };
    }
    for (const s of ov.suffix) {
        if (hostname === s.domain || hostname.endsWith("." + s.domain)) {
            return { category: s.category, flagged: !!s.flagged };
        }
    }
    if (HARDCODED_BY_DOMAIN[hostname]) {
        return { category: HARDCODED_BY_DOMAIN[hostname], flagged: !!HARDCODED_FLAGGED[hostname] };
    }
    if (HARDCODED_BY_DOMAIN[root]) {
        return { category: HARDCODED_BY_DOMAIN[root], flagged: !!HARDCODED_FLAGGED[root] };
    }
    for (const d of Object.keys(HARDCODED_BY_DOMAIN)) {
        if (hostname === d || hostname.endsWith("." + d)) {
            return { category: HARDCODED_BY_DOMAIN[d], flagged: !!HARDCODED_FLAGGED[d] };
        }
    }
    return { category: "other", flagged: false };
}

function seedDomainCategoriesIfEmpty() {
    let existing = 0;
    try { existing = $app.countRecords("domain_categories"); } catch (e) { return; }
    if (existing > 0) return;
    const col = $app.findCollectionByNameOrId("domain_categories");
    let inserted = 0;
    for (const cat of Object.keys(CATEGORIES)) {
        for (const domain of CATEGORIES[cat]) {
            const rec = new Record(col);
            rec.set("domain", domain);
            rec.set("category", cat);
            rec.set("flagged", cat === "adult");
            rec.set("match_type", "suffix");
            try { $app.save(rec); inserted += 1; } catch (e) { /* skip duplicates */ }
        }
    }
    $app.logger().info("seeded domain_categories", "inserted", inserted);
}

const SEARCH_PARAMS = {
    "google.com":"q","www.google.com":"q","bing.com":"q","www.bing.com":"q",
    "duckduckgo.com":"q","search.yahoo.com":"p","ecosia.org":"q",
    "www.ecosia.org":"q","search.brave.com":"q","kagi.com":"q",
    "youtube.com":"search_query","www.youtube.com":"search_query","m.youtube.com":"search_query",
    "amazon.com":"k","www.amazon.com":"k","reddit.com":"q","www.reddit.com":"q",
    "twitter.com":"q","x.com":"q","tiktok.com":"q","www.tiktok.com":"q",
};

function parseUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    if (typeof URL === "function") {
        try {
            const u = new URL(rawUrl);
            return {
                protocol: (u.protocol || "").replace(/:$/, ""),
                host: (u.host || "").toLowerCase(),
                hostname: (u.hostname || "").toLowerCase(),
                pathname: u.pathname || "/",
                search: u.search || "",
                hash: u.hash || "",
            };
        } catch (e) { /* fallthrough */ }
    }
    const m = /^(https?):\/\/([^\/\?#]+)([^\?#]*)?(\?[^#]*)?(#.*)?/i.exec(rawUrl);
    if (!m) return null;
    const hostFull = (m[2] || "").toLowerCase();
    const hostname = hostFull.replace(/:\d+$/, "");
    return {
        protocol: (m[1] || "").toLowerCase(),
        host: hostFull,
        hostname,
        pathname: m[3] || "/",
        search: m[4] || "",
        hash: m[5] || "",
    };
}

function rootDomain(host) {
    const parts = host.split(".");
    return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

function classify(url) {
    const p = parseUrl(url);
    if (!p) return { category: "other", flagged: false, domain: "", path: "/", query: "", protocol: "" };
    const { category, flagged } = lookupCategory(p.hostname);
    return {
        category, flagged,
        domain: p.host,
        path: p.pathname,
        query: p.search,
        protocol: p.protocol,
    };
}

function extractSearchQuery(url) {
    const p = parseUrl(url);
    if (!p || !p.search) return "";
    const param = SEARCH_PARAMS[p.hostname] || SEARCH_PARAMS[rootDomain(p.hostname)];
    if (!param) return "";
    const pairs = p.search.substring(1).split("&");
    for (const seg of pairs) {
        const eq = seg.indexOf("=");
        if (eq < 0) continue;
        if (seg.substring(0, eq) === param) {
            try { return decodeURIComponent(seg.substring(eq + 1).replace(/\+/g, " ")).trim(); }
            catch (e) { return seg.substring(eq + 1).replace(/\+/g, " ").trim(); }
        }
    }
    return "";
}

function dayKey(isoString) {
    if (!isoString) return new Date().toISOString().substring(0, 10);
    return String(isoString).substring(0, 10);
}

function pbDateString(jsDate) {
    return jsDate.toISOString().replace("T", " ").replace("Z", "");
}

function findOrNull(collection, filter, params) {
    try {
        return $app.findFirstRecordByFilter(collection, filter, params);
    } catch (err) {
        return null;
    }
}

function enrichRecord(record) {
    const url = record.getString("url");
    const info = classify(url);
    const query = extractSearchQuery(url);
    if (!record.getString("category")) record.set("category", info.category);
    if (!record.getString("domain")) record.set("domain", info.domain);
    if (!record.getString("path")) record.set("path", info.path);
    if (!record.getString("query")) record.set("query", info.query);
    if (!record.getString("protocol")) record.set("protocol", info.protocol);
    if (record.get("flagged") === undefined || record.get("flagged") === null) {
        record.set("flagged", info.flagged);
    }
    if (!record.getString("search_query") && query) record.set("search_query", query);
}

function getCursor() {
    const rec = findOrNull("system_state", "key = {:k}", { k: ROLLUP_CURSOR_KEY });
    if (rec) return rec;
    const col = $app.findCollectionByNameOrId("system_state");
    const fresh = new Record(col);
    fresh.set("key", ROLLUP_CURSOR_KEY);
    fresh.set("value", pbDateString(new Date(Date.now() - DEDUP_WINDOW_MS)));
    $app.save(fresh);
    return fresh;
}

function dedupBatch(rows) {
    rows.sort((a, b) => String(a.getString("visit_time")).localeCompare(b.getString("visit_time")));
    const leaderByKey = new Map();
    const survivors = [];
    const toDelete = [];
    for (const r of rows) {
        const key = r.getString("user_id") + "|" + r.getString("url");
        const leader = leaderByKey.get(key);
        const visitTimeMs = new Date(r.getString("visit_time")).getTime();
        if (leader) {
            const leaderMs = new Date(leader.getString("visit_time")).getTime();
            if (visitTimeMs - leaderMs <= DEDUP_WINDOW_MS) {
                const merged = (Number(leader.get("visit_count")) || 1) + (Number(r.get("visit_count")) || 1);
                leader.set("visit_count", merged);
                if (!leader.getString("title") && r.getString("title")) leader.set("title", r.getString("title"));
                if (!leader.get("duration") && r.get("duration")) leader.set("duration", r.get("duration"));
                toDelete.push(r);
                continue;
            }
        }
        leaderByKey.set(key, r);
        survivors.push(r);
    }
    return { survivors, toDelete };
}

function applyRollupForRow(r, newDomainCache) {
    const userId = r.getString("user_id");
    if (!userId) return;
    const userEmail = r.getString("user_email") || "";
    const visitTime = r.getString("visit_time") || r.getString("created");
    const domain = r.getString("domain") || "";
    const category = r.getString("category") || "other";
    const flagged = !!r.get("flagged");
    const visitCount = Number(r.get("visit_count")) || 1;
    const duration = Number(r.get("duration")) || 0;
    const searchQuery = r.getString("search_query") || "";
    const date = dayKey(visitTime);
    const dt = new Date(visitTime || Date.now());
    const weekday = dt.getUTCDay();
    const hour = dt.getUTCHours();

    let daily = findOrNull(
        "history_daily",
        "visit_date >= {:start} && visit_date < {:end} && user_id = {:u} && domain = {:d}",
        { start: date + " 00:00:00.000Z", end: date + " 23:59:59.999Z", u: userId, d: domain }
    );
    let isNewDomainForUser = false;
    if (!daily) {
        const col = $app.findCollectionByNameOrId("history_daily");
        daily = new Record(col);
        daily.set("visit_date", date + " 00:00:00.000Z");
        daily.set("user_id", userId);
        daily.set("user_email", userEmail);
        daily.set("domain", domain);
        daily.set("category", category);
        daily.set("flagged", flagged);
        daily.set("visits", 0);
        daily.set("visit_count_sum", 0);
        daily.set("duration_sum", 0);
        daily.set("search_count", 0);
        daily.set("first_visit", visitTime);
        const cacheKey = userId + "|" + domain;
        if (newDomainCache.has(cacheKey)) {
            isNewDomainForUser = false;
        } else {
            const prior = findOrNull("history_daily", "user_id = {:u} && domain = {:d}", { u: userId, d: domain });
            isNewDomainForUser = !prior;
            newDomainCache.set(cacheKey, true);
        }
    }
    daily.set("visits", (Number(daily.get("visits")) || 0) + 1);
    daily.set("visit_count_sum", (Number(daily.get("visit_count_sum")) || 0) + visitCount);
    daily.set("duration_sum", (Number(daily.get("duration_sum")) || 0) + duration);
    if (searchQuery) daily.set("search_count", (Number(daily.get("search_count")) || 0) + 1);
    daily.set("last_visit", visitTime);
    $app.save(daily);

    let hourly = findOrNull(
        "history_hourly_profile",
        "user_id = {:u} && weekday = {:w} && hour = {:h}",
        { u: userId, w: weekday, h: hour }
    );
    if (!hourly) {
        const col = $app.findCollectionByNameOrId("history_hourly_profile");
        hourly = new Record(col);
        hourly.set("user_id", userId);
        hourly.set("user_email", userEmail);
        hourly.set("weekday", weekday);
        hourly.set("hour", hour);
        hourly.set("visits", 0);
        hourly.set("flagged_visits", 0);
    }
    hourly.set("visits", (Number(hourly.get("visits")) || 0) + visitCount);
    if (flagged) hourly.set("flagged_visits", (Number(hourly.get("flagged_visits")) || 0) + visitCount);
    $app.save(hourly);

    let totals = findOrNull("history_user_totals", "user_id = {:u}", { u: userId });
    if (!totals) {
        const col = $app.findCollectionByNameOrId("history_user_totals");
        totals = new Record(col);
        totals.set("user_id", userId);
        totals.set("user_email", userEmail);
        totals.set("total_visits", 0);
        totals.set("total_duration", 0);
        totals.set("total_flagged", 0);
        totals.set("total_searches", 0);
        totals.set("unique_domains", 0);
        totals.set("first_seen", visitTime);
    }
    if (userEmail && !totals.getString("user_email")) totals.set("user_email", userEmail);
    totals.set("total_visits", (Number(totals.get("total_visits")) || 0) + visitCount);
    totals.set("total_duration", (Number(totals.get("total_duration")) || 0) + duration);
    if (flagged) totals.set("total_flagged", (Number(totals.get("total_flagged")) || 0) + visitCount);
    if (searchQuery) totals.set("total_searches", (Number(totals.get("total_searches")) || 0) + 1);
    if (isNewDomainForUser) totals.set("unique_domains", (Number(totals.get("unique_domains")) || 0) + 1);
    totals.set("last_seen", visitTime);
    $app.save(totals);

    if (searchQuery) {
        let search = findOrNull(
            "history_search_daily",
            "visit_date >= {:start} && visit_date < {:end} && user_id = {:u} && search_query = {:q}",
            { start: date + " 00:00:00.000Z", end: date + " 23:59:59.999Z", u: userId, q: searchQuery }
        );
        if (!search) {
            const col = $app.findCollectionByNameOrId("history_search_daily");
            search = new Record(col);
            search.set("visit_date", date + " 00:00:00.000Z");
            search.set("user_id", userId);
            search.set("user_email", userEmail);
            search.set("search_query", searchQuery);
            search.set("count", 0);
        }
        search.set("count", (Number(search.get("count")) || 0) + visitCount);
        search.set("last_seen", visitTime);
        $app.save(search);
    }
}

function runRollupTick() {
    const cursorRec = getCursor();
    const cursorStr = cursorRec.getString("value");
    const endTimeMs = Date.now() - SAFETY_BUFFER_MS;
    const endTimeStr = pbDateString(new Date(endTimeMs));

    if (cursorStr >= endTimeStr) return { processed: 0, merged: 0 };

    let processedCount = 0;
    let mergedCount = 0;

    $app.runInTransaction((txApp) => {
        const rows = txApp.findRecordsByFilter(
            "history",
            "created > {:c} && created <= {:e}",
            "+visit_time",
            5000,
            0,
            { c: cursorStr, e: endTimeStr }
        );
        processedCount = rows.length;

        if (rows.length === 0) {
            cursorRec.set("value", endTimeStr);
            txApp.save(cursorRec);
            return;
        }

        const { survivors, toDelete } = dedupBatch(rows);
        mergedCount = toDelete.length;

        for (const r of survivors) txApp.save(r);
        for (const r of toDelete) txApp.delete(r);

        const newDomainCache = new Map();
        for (const r of survivors) applyRollupForRow(r, newDomainCache);

        cursorRec.set("value", endTimeStr);
        txApp.save(cursorRec);
    });

    $app.logger().info(
        "history rollup tick",
        "processed", processedCount,
        "merged", mergedCount,
        "cursor", endTimeStr,
    );
    return { processed: processedCount, merged: mergedCount };
}

// Patterns matched against the `domain` field (which is host:port).
// Using exact + ":" prefix instead of plain contains avoids false-positives
// on hypothetical real domains that happen to embed these substrings.
//
// Edit this list to extend (e.g. add `10.` for the 10.0.0.0/8 RFC1918
// range, or `172.16.` through `172.31.` for the 172.16/12 range).
const PRIVATE_HOST_FILTERS = [
    'domain = "localhost"',
    'domain ~ "localhost:"',
    'domain = "127.0.0.1"',
    'domain ~ "127.0.0.1:"',
    'domain ~ "192.168."',
    'domain ~ "[::1]"',
];

function purgePrivateNetworkRecords() {
    const filter = PRIVATE_HOST_FILTERS.join(" || ");
    let deletedHistory = 0;
    let deletedDaily = 0;
    let deletedSearchByDomain = 0;

    $app.runInTransaction((txApp) => {
        // history (raw rows)
        const histRows = txApp.findRecordsByFilter("history", filter, "", 50000, 0);
        for (const r of histRows) txApp.delete(r);
        deletedHistory = histRows.length;

        // history_daily — same domain semantics, same filter works.
        const dailyRows = txApp.findRecordsByFilter("history_daily", filter, "", 50000, 0);
        for (const r of dailyRows) txApp.delete(r);
        deletedDaily = dailyRows.length;

        // history_search_daily has no `domain` column, but searches against
        // localhost/private hosts are vanishingly rare in practice, so we
        // leave it alone. history_hourly_profile and history_user_totals
        // also lack a domain dimension; their counts may be slightly inflated
        // by purged rows, which is acceptable for a dev-cleanup job.
    });

    $app.logger().info(
        "purged private-network history",
        "history", deletedHistory,
        "history_daily", deletedDaily,
    );
    return { deletedHistory, deletedDaily, deletedSearchByDomain };
}

function notifyFlaggedHit(record) {
    if (!record.get("flagged")) return;
    const domain = record.getString("domain") || "";
    if (!domain) return;

    const visitTime = record.getString("visit_time") || record.getString("created");
    const dayUTC = (visitTime ? new Date(visitTime) : new Date())
        .toISOString().slice(0, 10);
    const dedupKey = "flagged_notify:" + dayUTC + ":" + domain.toLowerCase();

    try {
        const col = $app.findCollectionByNameOrId("system_state");
        const claim = new Record(col);
        claim.set("key", dedupKey);
        claim.set("value", new Date().toISOString());
        $app.save(claim);
    } catch (e) {
        return;
    }

    let toEmail = "";
    try {
        const supers = $app.findAllRecords("_superusers");
        if (supers && supers.length) toEmail = supers[0].getString("email");
    } catch (e) { /* fall through */ }
    if (!toEmail) {
        console.log("[notify] no superuser email found; skipping send for " + domain);
        return;
    }

    const url = record.getString("url");
    const title = record.getString("title") || "(no title)";
    const category = record.getString("category") || "other";
    const userEmail = record.getString("user_email") || "(unknown)";
    const searchQuery = record.getString("search_query") || "";
    let appURL = "";
    try { appURL = $app.settings().meta.appURL || ""; } catch (e) { /* ignore */ }
    const dashboardLink = appURL
        ? appURL.replace(/\/$/, "") + "/_/#/collections?collection=history&filter=flagged%3Dtrue"
        : "";

    const safe = (s) => String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]));

    const html =
        "<h2>Flagged domain visited</h2>" +
        "<p><strong>Domain:</strong> " + safe(domain) + "</p>" +
        "<p><strong>Category:</strong> " + safe(category) + "</p>" +
        "<p><strong>User:</strong> " + safe(userEmail) + "</p>" +
        "<p><strong>Visit time:</strong> " + safe(visitTime) + "</p>" +
        "<p><strong>Title:</strong> " + safe(title) + "</p>" +
        "<p><strong>URL:</strong> <a href=\"" + safe(url) + "\">" + safe(url) + "</a></p>" +
        (searchQuery ? "<p><strong>Search query:</strong> " + safe(searchQuery) + "</p>" : "") +
        (dashboardLink ? "<p><a href=\"" + safe(dashboardLink) + "\">Open flagged history in dashboard</a></p>" : "") +
        "<hr>" +
        "<p style=\"color:#888;font-size:12px\">You will not receive another email for <code>" +
        safe(domain) + "</code> until " + safe(dayUTC) + " (UTC) ends.</p>";

    try {
        const settings = $app.settings();
        const message = new MailerMessage({
            from: {
                address: settings.meta.senderAddress,
                name: settings.meta.senderName,
            },
            to: [{ address: toEmail }],
            subject: "Flagged domain visited: " + domain,
            html: html,
        });
        $app.newMailClient().send(message);
        console.log("[notify] sent flagged-domain email for " + domain + " to " + toEmail);
    } catch (e) {
        console.log("[notify] send failed for " + domain + ": " + e);
    }
}

module.exports = {
    enrichRecord,
    runRollupTick,
    seedDomainCategoriesIfEmpty,
    purgePrivateNetworkRecords,
    notifyFlaggedHit,
};
