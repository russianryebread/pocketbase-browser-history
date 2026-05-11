(function (global) {
    const CATEGORIES = {
        social: [
            "facebook.com", "instagram.com", "twitter.com", "x.com",
            "tiktok.com", "snapchat.com", "reddit.com", "linkedin.com",
            "pinterest.com", "threads.net", "bsky.app", "discord.com",
            "discordapp.com", "tumblr.com", "mastodon.social", "vk.com",
            "weibo.com", "quora.com",
        ],
        video: [
            "youtube.com", "youtu.be", "m.youtube.com", "twitch.tv",
            "netflix.com", "hulu.com", "disneyplus.com", "primevideo.com",
            "hbomax.com", "max.com", "peacocktv.com", "vimeo.com",
            "dailymotion.com", "paramountplus.com", "appletv.com", "crunchyroll.com",
            "funimation.com", "tubitv.com", "pluto.tv",
        ],
        gaming: [
            "roblox.com", "steampowered.com", "steamcommunity.com",
            "minecraft.net", "epicgames.com", "fortnite.com", "ea.com",
            "ubisoft.com", "rockstargames.com", "playstation.com", "xbox.com",
            "nintendo.com", "curseforge.com", "mojang.com", "battle.net",
            "blizzard.com", "leagueoflegends.com", "valorant.com",
            "riotgames.com", "ign.com", "gamespot.com", "kongregate.com",
            "miniclip.com", "poki.com", "crazygames.com", "y8.com",
        ],
        news: [
            "cnn.com", "foxnews.com", "nytimes.com", "bbc.com", "bbc.co.uk",
            "reuters.com", "theguardian.com", "washingtonpost.com", "npr.org",
            "apnews.com", "bloomberg.com", "wsj.com", "usatoday.com",
            "abcnews.go.com", "nbcnews.com", "cbsnews.com", "huffpost.com",
            "politico.com", "axios.com", "vox.com", "economist.com",
        ],
        adult: [
            "pornhub.com", "xvideos.com", "xnxx.com", "redtube.com",
            "xhamster.com", "youporn.com", "onlyfans.com", "chaturbate.com",
            "brazzers.com", "manyvids.com", "stripchat.com", "livejasmin.com",
            "tnaflix.com", "eporner.com", "spankbang.com", "beeg.com",
            "motherless.com", "tube8.com", "hentai-foundry.com", "e-hentai.org",
            "nhentai.net", "rule34.xxx", "fakku.net", "literotica.com",
            "fetlife.com", "adultfriendfinder.com", "ashleymadison.com",
        ],
        education: [
            "khanacademy.org", "duolingo.com", "coursera.org", "edx.org",
            "codecademy.com", "udemy.com", "brilliant.org", "ixl.com",
            "prodigygame.com", "quizlet.com", "kahoot.com", "kahoot.it",
            "scratch.mit.edu", "code.org", "classroom.google.com",
            "wikipedia.org", "wikimedia.org", "ck12.org", "edmodo.com",
            "schoology.com", "canvas.instructure.com", "blackboard.com",
            "freecodecamp.org", "leetcode.com", "hackerrank.com",
        ],
        shopping: [
            "amazon.com", "ebay.com", "etsy.com", "walmart.com", "target.com",
            "bestbuy.com", "homedepot.com", "costco.com", "aliexpress.com",
            "temu.com", "shein.com", "wayfair.com", "macys.com",
            "kohls.com", "nike.com", "adidas.com", "ikea.com",
            "newegg.com", "wish.com", "groupon.com",
        ],
        search: [
            "google.com", "bing.com", "duckduckgo.com", "yahoo.com",
            "ecosia.org", "brave.com", "search.brave.com", "kagi.com",
            "startpage.com", "qwant.com",
        ],
        productivity: [
            "github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com",
            "stackexchange.com", "notion.so", "slack.com", "trello.com",
            "asana.com", "atlassian.com", "atlassian.net", "monday.com",
            "office.com", "office365.com", "microsoft.com", "live.com",
            "outlook.com", "docs.google.com", "drive.google.com",
            "sheets.google.com", "calendar.google.com", "mail.google.com",
            "dropbox.com", "box.com", "zoom.us", "webex.com",
            "figma.com", "miro.com", "loom.com",
        ],
        ai: [
            "chatgpt.com", "openai.com", "claude.ai", "anthropic.com",
            "gemini.google.com", "bard.google.com", "perplexity.ai",
            "copilot.microsoft.com", "character.ai", "you.com",
            "huggingface.co", "midjourney.com", "runwayml.com",
        ],
    };

    const HARDCODED_BY_DOMAIN = {};
    for (const cat of Object.keys(CATEGORIES)) {
        for (const d of CATEGORIES[cat]) HARDCODED_BY_DOMAIN[d] = cat;
    }
    const HARDCODED_FLAGGED = new Set(CATEGORIES.adult);

    // DB overrides loaded asynchronously via loadFromPB(pb).
    let dbOverrides = { exact: {}, flaggedExact: new Set(), suffix: [] };

    async function loadFromPB(pb) {
        if (!pb || typeof pb.collection !== "function") return;
        try {
            const recs = await pb.collection("domain_categories").getFullList({
                fields: "domain,category,flagged,match_type",
                requestKey: null,
            });
            const exact = {};
            const flaggedExact = new Set();
            const suffix = [];
            for (const r of recs) {
                const d = (r.domain || "").toLowerCase();
                if (!d) continue;
                if (r.match_type === "suffix") {
                    suffix.push({ domain: d, category: r.category || "other", flagged: !!r.flagged });
                } else {
                    exact[d] = r.category || "other";
                    if (r.flagged) flaggedExact.add(d);
                }
            }
            suffix.sort((a, b) => b.domain.length - a.domain.length);
            dbOverrides = { exact, flaggedExact, suffix };
        } catch (e) {
            // Collection may not exist or user not authed — just keep hardcoded.
            console.warn("domain_categories load failed:", e.message);
        }
    }

    function lookup(hostname) {
        if (!hostname) return { category: "other", flagged: false };
        if (dbOverrides.exact[hostname]) {
            return { category: dbOverrides.exact[hostname], flagged: dbOverrides.flaggedExact.has(hostname) };
        }
        const root = rootDomain(hostname);
        if (dbOverrides.exact[root]) {
            return { category: dbOverrides.exact[root], flagged: dbOverrides.flaggedExact.has(root) };
        }
        for (const s of dbOverrides.suffix) {
            if (hostname === s.domain || hostname.endsWith("." + s.domain)) {
                return { category: s.category, flagged: s.flagged };
            }
        }
        if (HARDCODED_BY_DOMAIN[hostname]) {
            return { category: HARDCODED_BY_DOMAIN[hostname], flagged: HARDCODED_FLAGGED.has(hostname) };
        }
        if (HARDCODED_BY_DOMAIN[root]) {
            return { category: HARDCODED_BY_DOMAIN[root], flagged: HARDCODED_FLAGGED.has(root) };
        }
        for (const d of Object.keys(HARDCODED_BY_DOMAIN)) {
            if (hostname === d || hostname.endsWith("." + d)) {
                return { category: HARDCODED_BY_DOMAIN[d], flagged: HARDCODED_FLAGGED.has(d) };
            }
        }
        return { category: "other", flagged: false };
    }

    const SEARCH_PARAMS = {
        "google.com": "q", "www.google.com": "q",
        "bing.com": "q", "www.bing.com": "q",
        "duckduckgo.com": "q",
        "search.yahoo.com": "p",
        "ecosia.org": "q", "www.ecosia.org": "q",
        "search.brave.com": "q",
        "kagi.com": "q",
        "youtube.com": "search_query", "www.youtube.com": "search_query", "m.youtube.com": "search_query",
        "amazon.com": "k", "www.amazon.com": "k",
        "reddit.com": "q", "www.reddit.com": "q",
        "twitter.com": "q", "x.com": "q",
        "tiktok.com": "q", "www.tiktok.com": "q",
    };

    function safeUrl(url) {
        try { return new URL(url); } catch (e) { return null; }
    }

    function rootDomain(hostname) {
        const parts = hostname.split(".");
        if (parts.length <= 2) return hostname;
        return parts.slice(-2).join(".");
    }

    function parse(url) {
        const u = safeUrl(url);
        if (!u) return { protocol: "", host: "", hostname: "", path: "/", query: "", hash: "" };
        return {
            protocol: u.protocol.replace(/:$/, ""),
            host: u.host.toLowerCase(),
            hostname: u.hostname.toLowerCase(),
            path: u.pathname || "/",
            query: u.search || "",
            hash: u.hash || "",
        };
    }

    function classify(url) {
        const p = parse(url);
        if (!p.hostname) return { category: "other", flagged: false, domain: "", path: "/", query: "", protocol: "" };
        const { category, flagged } = lookup(p.hostname);
        return {
            category,
            flagged,
            domain: p.host,
            path: p.path,
            query: p.query,
            protocol: p.protocol,
        };
    }

    function extractSearchQuery(url) {
        const u = safeUrl(url);
        if (!u) return "";
        const host = u.hostname.toLowerCase();
        const param = SEARCH_PARAMS[host] || SEARCH_PARAMS[rootDomain(host)];
        if (!param) return "";
        const isSearchPath =
            u.pathname === "/search" ||
            u.pathname.startsWith("/search/") ||
            u.pathname === "/results" ||
            host.startsWith("www.google.") || host === "duckduckgo.com" ||
            host.startsWith("www.bing.") || host.includes("ecosia") ||
            host.includes("kagi") || host.includes("brave") ||
            host.endsWith("amazon.com");
        if (!isSearchPath && !u.searchParams.has(param)) return "";
        return (u.searchParams.get(param) || "").trim();
    }

    function getHostname(url) {
        return parse(url).hostname;
    }
    function getHost(url) {
        return parse(url).host;
    }

    global.HistoryCategories = {
        classify,
        extractSearchQuery,
        loadFromPB,
        parse,
        getHostname,
        getHost,
        CATEGORIES,
    };
})(typeof window !== "undefined" ? window : globalThis);
