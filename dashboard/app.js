const POCKETBASE_URL = "https://az.hoshor.me:8001";
const RAW_LIMIT = 50000;
const PAGE_SIZE = 500;
const ROLLUP_THRESHOLD_DAYS = 90;
const LATE_NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4, 5]);

function dashboard() {
    return {
        pb: null,
        authed: false,
        username: "",
        password: "",
        loading: false,
        loadingMessage: "",
        error: "",

        users: [],
        selectedUserEmail: "",
        selectedDomain: "",
        rangePreset: "30d",
        customFrom: "",
        customTo: "",
        autoRefresh: false,
        autoRefreshTimer: null,

        historyRows: [],
        dailyRows: [],
        hourlyRows: [],
        searchRows: [],
        userTotals: null,

        rowCount: 0,
        charts: {},

        get subtitle() {
            if (!this.authed) return "Discover insights from your browsing patterns";
            const who = this.selectedUserEmail || "all users";
            return `${this.rangeLabel} • ${who}`;
        },

        get rangeLabel() {
            const labels = {
                today: "Today",
                "7d": "Last 7 days",
                "30d": "Last 30 days",
                "90d": "Last 90 days",
                "1y": "Last year",
                all: "All time",
                custom: "Custom",
            };
            return labels[this.rangePreset] || this.rangePreset;
        },

        get rangeBounds() {
            const now = new Date();
            const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
            const day = 24 * 60 * 60 * 1000;
            switch (this.rangePreset) {
                case "today":
                    return { from: today, to: new Date(today.getTime() + day) };
                case "7d":
                    return { from: new Date(today.getTime() - 7 * day), to: new Date(today.getTime() + day) };
                case "30d":
                    return { from: new Date(today.getTime() - 30 * day), to: new Date(today.getTime() + day) };
                case "90d":
                    return { from: new Date(today.getTime() - 90 * day), to: new Date(today.getTime() + day) };
                case "1y":
                    return { from: new Date(today.getTime() - 365 * day), to: new Date(today.getTime() + day) };
                case "all":
                    return { from: new Date("1970-01-01T00:00:00Z"), to: new Date(today.getTime() + day) };
                case "custom":
                    return {
                        from: this.customFrom ? new Date(this.customFrom + "T00:00:00Z") : new Date(today.getTime() - 30 * day),
                        to: this.customTo ? new Date(this.customTo + "T23:59:59Z") : new Date(today.getTime() + day),
                    };
                default:
                    return { from: new Date(today.getTime() - 30 * day), to: new Date(today.getTime() + day) };
            }
        },

        get rangeDays() {
            const { from, to } = this.rangeBounds;
            return Math.max(1, Math.ceil((to - from) / (24 * 60 * 60 * 1000)));
        },

        get useRollups() {
            return this.rangeDays > ROLLUP_THRESHOLD_DAYS || this.rangePreset === "all";
        },

        async init() {
            this.pb = new PocketBase(POCKETBASE_URL);
            // Disable auto-cancellation: paginating the same collection fires
            // multiple getList calls with the same default requestKey, which
            // would otherwise cancel each other.
            this.pb.autoCancellation(false);
            if (this.pb.authStore.isValid) {
                this.authed = true;
                await this.afterAuth();
            }
            // Re-render only on coarse state changes. Per-array watches would
            // each fire during a single loadData() call (4 array assignments
            // → 4 cancel/reschedule cycles), and queued ResizeObserver
            // callbacks against destroyed canvases were the real source of
            // the "t is null" crash. loadData() calls scheduleRender once at
            // the end; selectedDomain re-renders without a re-fetch.
            this.$watch("selectedDomain", () => this.scheduleRender());
        },

        async login() {
            if (!this.username || !this.password) {
                this.error = "Enter email and password";
                return;
            }
            this.error = "";
            this.loading = true;
            this.loadingMessage = "Authenticating...";
            try {
                await this.pb.collection("users").authWithPassword(this.username, this.password);
                this.authed = true;
                this.password = "";
                await this.afterAuth();
            } catch (e) {
                this.error = `Authentication failed: ${e.message}`;
            } finally {
                this.loading = false;
            }
        },

        async logout() {
            this.pb.authStore.clear();
            this.authed = false;
            this.historyRows = [];
            this.dailyRows = [];
            this.hourlyRows = [];
            this.searchRows = [];
            this.users = [];
            this.username = "";
            this.password = "";
            Object.values(this.charts).forEach((c) => c?.destroy());
            this.charts = {};
            if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
        },

        async afterAuth() {
            await Promise.all([
                this.loadUsers(),
                HistoryCategories.loadFromPB(this.pb),
            ]);
            await this.loadData();
        },

        async loadUsers() {
            // Distinct emails from the user-totals rollup. One email may map to
            // multiple user_ids (devices); we collapse to a single entry per
            // email and surface device count in the label.
            const byEmail = new Map();
            const addRow = (email, deviceId) => {
                const e = (email || "").trim();
                if (!e) return;
                if (!byEmail.has(e)) byEmail.set(e, new Set());
                if (deviceId) byEmail.get(e).add(deviceId);
            };

            try {
                const list = await this.pb.collection("history_user_totals").getFullList({
                    fields: "user_email,user_id",
                    sort: "user_email",
                    requestKey: null,
                });
                for (const row of list) addRow(row.user_email, row.user_id);
            } catch (e) {
                console.warn("history_user_totals unavailable, falling back to history scan", e.message);
            }

            // Fallback: rollups may be empty on a fresh install or before the
            // first cron tick. Scan a sample of recent history rows so the
            // dropdown still populates.
            if (byEmail.size === 0) {
                try {
                    const sample = await this.pb.collection("history").getList(1, 500, {
                        sort: "-visit_time",
                        fields: "user_email,user_id",
                        requestKey: null,
                    });
                    for (const row of sample.items) addRow(row.user_email, row.user_id);
                } catch (e) {
                    console.warn("history sample fallback failed", e.message);
                }
            }

            this.users = Array.from(byEmail.entries())
                .map(([email, devices]) => ({ email, deviceCount: devices.size }))
                .sort((a, b) => a.email.localeCompare(b.email));
        },

        onRangeChange() {
            this.selectedDomain = "";
            if (this.rangePreset !== "custom") this.loadData();
        },

        onUserChange() {
            this.selectedDomain = "";
            this.loadData();
        },

        pickDomain(domain) {
            this.selectedDomain = this.selectedDomain === domain ? "" : domain;
        },

        clearDomain() {
            this.selectedDomain = "";
        },

        toggleAutoRefresh() {
            if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
            this.autoRefreshTimer = null;
            if (this.autoRefresh) {
                this.autoRefreshTimer = setInterval(() => this.loadData(), 60000);
            }
        },

        async loadData() {
            if (!this.pb || !this.pb.authStore.isValid) return;
            this.error = "";
            this.loading = true;
            try {
                const { from, to } = this.rangeBounds;
                const fromIso = isoForFilter(from);
                const toIso = isoForFilter(to);
                const userClause = this.selectedUserEmail ? ` && user_email = "${escapeFilter(this.selectedUserEmail)}"` : "";

                if (this.useRollups) {
                    this.loadingMessage = "Loading rollups...";
                    const dailyFilter = `visit_date >= "${fromIso}" && visit_date <= "${toIso}"${userClause}`;
                    const searchFilter = `visit_date >= "${fromIso}" && visit_date <= "${toIso}"${userClause}`;
                    const [daily, search] = await Promise.all([
                        this.fetchAll("history_daily", dailyFilter, "+visit_date"),
                        this.fetchAll("history_search_daily", searchFilter, "-count"),
                    ]);
                    this.dailyRows = daily;
                    this.searchRows = search;
                    this.historyRows = [];
                    this.rowCount = daily.length + search.length;
                } else {
                    this.loadingMessage = "Loading history...";
                    const filter = `visit_time >= "${fromIso}" && visit_time <= "${toIso}"${userClause}`;
                    const rows = await this.fetchAll(
                        "history",
                        filter,
                        "-visit_time",
                        "id,url,title,visit_time,visit_count,user_email,user_id,duration,category,flagged,domain,path,query,protocol,search_query"
                    );
                    this.historyRows = rows;
                    this.dailyRows = [];
                    this.rowCount = rows.length;

                    const dayFromIso = isoForFilter(addDays(this.rangeBounds.from, -1));
                    const dayToIso = isoForFilter(this.rangeBounds.to);
                    const searchFilter = `visit_date >= "${dayFromIso}" && visit_date <= "${dayToIso}"${userClause}`;
                    this.searchRows = await this.fetchAll("history_search_daily", searchFilter, "-count").catch(() => []);
                }

                this.loadingMessage = "Loading heatmap...";
                const hourlyFilter = this.selectedUserEmail ? `user_email = "${escapeFilter(this.selectedUserEmail)}"` : "";
                this.hourlyRows = await this.fetchAll("history_hourly_profile", hourlyFilter, "+weekday").catch(() => []);

                if (this.selectedUserEmail) {
                    try {
                        // Sum across all devices belonging to this email.
                        const totalsRows = await this.pb.collection("history_user_totals").getFullList({
                            filter: `user_email = "${escapeFilter(this.selectedUserEmail)}"`,
                            requestKey: null,
                        });
                        this.userTotals = aggregateTotals(totalsRows);
                    } catch (e) {
                        this.userTotals = null;
                    }
                } else {
                    this.userTotals = null;
                }
            } catch (e) {
                console.error(e);
                this.error = `Error loading data: ${e.message}`;
            } finally {
                this.loading = false;
                if (!this.error) this.scheduleRender();
            }
        },

        async fetchAll(collection, filter, sort, fields) {
            const all = [];
            let page = 1;
            while (true) {
                const opts = { filter, sort, requestKey: null };
                if (fields) opts.fields = fields;
                const result = await this.pb.collection(collection).getList(page, PAGE_SIZE, opts);
                all.push(...result.items);
                this.loadingMessage = `Loading ${collection}: ${all.length} / ${result.totalItems}`;
                if (result.items.length < PAGE_SIZE || all.length >= RAW_LIMIT) break;
                page += 1;
            }
            return all;
        },

        get sourceRows() {
            return this.useRollups ? this.dailyRows : this.historyRows;
        },

        get filteredHistory() {
            return this.selectedDomain
                ? this.historyRows.filter((r) => (r.domain || "") === this.selectedDomain)
                : this.historyRows;
        },

        get filteredDaily() {
            return this.selectedDomain
                ? this.dailyRows.filter((r) => (r.domain || "") === this.selectedDomain)
                : this.dailyRows;
        },

        get kpiCards() {
            const k = this.kpis;
            return [
                { label: "Total Visits", value: this.fmt(k.totalVisits) },
                { label: "Unique Domains", value: this.fmt(k.uniqueDomains) },
                { label: "Active Users", value: this.fmt(k.activeUsers) },
                { label: "Avg Daily", value: this.fmt(k.avgDaily) },
                { label: "Flagged", value: this.fmt(k.flagged), flag: k.flagged > 0 },
                { label: "Screen Time", value: this.fmtDuration(k.totalDuration) },
                { label: "Searches", value: this.fmt(k.searches) },
                { label: "Late-night", value: this.fmt(k.lateNight) },
            ];
        },

        get kpis() {
            if (this.useRollups) {
                let totalVisits = 0, totalDuration = 0, flagged = 0, searches = 0;
                const domains = new Set();
                const users = new Set();
                for (const r of this.filteredDaily) {
                    totalVisits += r.visits || 0;
                    totalDuration += r.duration_sum || 0;
                    if (r.flagged) flagged += r.visits || 0;
                    searches += r.search_count || 0;
                    domains.add(r.domain);
                    users.add(r.user_email || r.user_id);
                }
                let lateNight = 0;
                for (const h of this.hourlyRows) {
                    if (this.selectedUserEmail && h.user_email !== this.selectedUserEmail) continue;
                    if (LATE_NIGHT_HOURS.has(h.hour)) lateNight += h.visits || 0;
                }
                return {
                    totalVisits,
                    uniqueDomains: domains.size,
                    activeUsers: users.size,
                    avgDaily: Math.round(totalVisits / this.rangeDays),
                    flagged,
                    totalDuration,
                    searches,
                    lateNight,
                };
            }
            const rows = this.filteredHistory;
            let totalVisits = 0, totalDuration = 0, flagged = 0, searches = 0, lateNight = 0;
            const domains = new Set(), users = new Set();
            for (const r of rows) {
                totalVisits += r.visit_count || 1;
                totalDuration += r.duration || 0;
                if (r.flagged) flagged += 1;
                if (r.search_query) searches += 1;
                domains.add(r.domain || HistoryCategories.getHost(r.url));
                users.add(r.user_id);
                const hr = new Date(r.visit_time).getHours();
                if (LATE_NIGHT_HOURS.has(hr)) lateNight += 1;
            }
            return {
                totalVisits,
                uniqueDomains: domains.size,
                activeUsers: users.size,
                avgDaily: Math.round(totalVisits / this.rangeDays),
                flagged,
                totalDuration,
                searches,
                lateNight,
            };
        },

        get insights() {
            const out = [];
            const daily = this.dailyTrend;
            if (daily.labels.length) {
                const peakIdx = daily.values.reduce((acc, v, i) => (v > daily.values[acc] ? i : acc), 0);
                out.push({
                    title: "Most Active Day",
                    description: `${daily.labels[peakIdx]} with ${daily.values[peakIdx]} visits`,
                });
            }
            const hourTotals = this.hourTotals();
            const peakHour = hourTotals.indexOf(Math.max(...hourTotals));
            if (hourTotals[peakHour] > 0) {
                out.push({
                    title: "Peak Usage Hour",
                    description: `${peakHour}:00 — ${hourTotals[peakHour]} visits`,
                });
            }
            const td = this.topDomains;
            if (td.length) {
                const pct = Math.round((td[0].count / Math.max(1, this.kpis.totalVisits)) * 100);
                out.push({
                    title: "Top Domain",
                    description: `${td[0].label} = ${pct}% of visits`,
                });
            }
            if (this.kpis.flagged > 0) {
                out.push({
                    title: "Flagged Activity",
                    description: `${this.kpis.flagged} flagged visit${this.kpis.flagged === 1 ? "" : "s"} in window`,
                });
            }
            if (this.kpis.lateNight > 0) {
                out.push({
                    title: "Late-night Browsing",
                    description: `${this.kpis.lateNight} visits between 10pm–6am`,
                });
            }
            const cats = this.categoryMix;
            if (cats.length) {
                out.push({
                    title: "Top Category",
                    description: `${cats[0].label} (${cats[0].count} visits)`,
                });
            }
            return out;
        },

        get dailyTrend() {
            const map = new Map();
            if (this.useRollups) {
                // Rollups are server-bucketed UTC days; we can't shift them
                // here without re-aggregating. Use the raw bucket date.
                for (const r of this.filteredDaily) {
                    const d = String(r.visit_date).substring(0, 10);
                    map.set(d, (map.get(d) || 0) + (r.visits || 0));
                }
            } else {
                for (const r of this.filteredHistory) {
                    const d = localDateKey(new Date(r.visit_time));
                    map.set(d, (map.get(d) || 0) + (r.visit_count || 1));
                }
            }
            const labels = Array.from(map.keys()).sort();
            return { labels, values: labels.map((l) => map.get(l)) };
        },

        get categoryMix() {
            const map = new Map();
            if (this.useRollups) {
                for (const r of this.filteredDaily) {
                    const c = r.category || "other";
                    map.set(c, (map.get(c) || 0) + (r.visits || 0));
                }
            } else {
                for (const r of this.filteredHistory) {
                    const c = r.category || HistoryCategories.classify(r.url || "").category;
                    map.set(c, (map.get(c) || 0) + (r.visit_count || 1));
                }
            }
            return Array.from(map.entries())
                .map(([label, count]) => ({ label, count }))
                .sort((a, b) => b.count - a.count);
        },

        // All domains in window — used by both the doughnut and the clickable list.
        // Intentionally NOT filtered by selectedDomain so the user can switch.
        domainCounts() {
            const map = new Map();
            if (this.useRollups) {
                for (const r of this.dailyRows) {
                    if (!r.domain) continue;
                    map.set(r.domain, (map.get(r.domain) || 0) + (r.visits || 0));
                }
            } else {
                for (const r of this.historyRows) {
                    const d = r.domain || HistoryCategories.getHost(r.url);
                    if (!d) continue;
                    map.set(d, (map.get(d) || 0) + (r.visit_count || 1));
                }
            }
            return Array.from(map.entries())
                .map(([label, count]) => ({ label, count }))
                .sort((a, b) => b.count - a.count);
        },

        get topDomains() {
            return this.domainCounts().slice(0, 10);
        },

        get topDomainsList() {
            return this.domainCounts().slice(0, 50);
        },

        get topPaths() {
            if (this.useRollups) return [];
            const map = new Map();
            const rows = this.selectedDomain
                ? this.historyRows.filter((r) => (r.domain || "") === this.selectedDomain)
                : this.historyRows;
            for (const r of rows) {
                const path = r.path || "/";
                map.set(path, (map.get(path) || 0) + (r.visit_count || 1));
            }
            return Array.from(map.entries())
                .map(([label, count]) => ({ label, count }))
                .sort((a, b) => b.count - a.count);
        },

        get topSearches() {
            const map = new Map();
            for (const r of this.searchRows) {
                map.set(r.search_query, (map.get(r.search_query) || 0) + (r.count || 0));
            }
            if (!this.useRollups) {
                for (const r of this.historyRows) {
                    if (r.search_query) {
                        map.set(r.search_query, (map.get(r.search_query) || 0) + 1);
                    }
                }
            }
            return Array.from(map.entries())
                .map(([query, count]) => ({ query, count }))
                .sort((a, b) => b.count - a.count);
        },

        get topSites() {
            if (this.useRollups) return [];
            const map = new Map();
            for (const r of this.filteredHistory) {
                map.set(r.url, (map.get(r.url) || 0) + (r.visit_count || 1));
            }
            return Array.from(map.entries())
                .map(([url, count]) => ({ url, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 20);
        },

        get flaggedItems() {
            if (this.useRollups) {
                return this.filteredDaily
                    .filter((r) => r.flagged)
                    .sort((a, b) => String(b.last_visit).localeCompare(String(a.last_visit)))
                    .map((r) => ({
                        id: r.id,
                        url: r.domain,
                        domain: r.domain,
                        visit_time: r.last_visit,
                        user_email: r.user_email,
                        user_id: r.user_id,
                    }));
            }
            return this.filteredHistory
                .filter((r) => r.flagged)
                .sort((a, b) => String(b.visit_time).localeCompare(String(a.visit_time)));
        },

        get recentActivity() {
            return this.filteredHistory.slice(0, 100);
        },

        get perUserBreakdown() {
            const map = new Map();
            if (this.useRollups) {
                for (const r of this.filteredDaily) {
                    const k = r.user_email || "(no email)";
                    map.set(k, (map.get(k) || 0) + (r.visits || 0));
                }
            } else {
                for (const r of this.filteredHistory) {
                    const k = r.user_email || "(no email)";
                    map.set(k, (map.get(k) || 0) + (r.visit_count || 1));
                }
            }
            return Array.from(map.entries())
                .map(([label, count]) => ({ label, count }))
                .sort((a, b) => b.count - a.count);
        },

        get streakDays() {
            const map = new Map();
            for (const r of this.dailyTrend.labels) {
                map.set(r, this.dailyTrend.values[this.dailyTrend.labels.indexOf(r)]);
            }
            const out = [];
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const max = Math.max(1, ...this.dailyTrend.values);
            for (let i = 89; i >= 0; i--) {
                const d = new Date(today.getTime() - i * 86400000);
                const key = localDateKey(d);
                const count = map.get(key) || 0;
                const intensity = count === 0 ? 0 : 0.12 + 0.88 * Math.min(1, count / max);
                const color = count === 0 ? "#f4f4f5" : `rgba(15, 23, 42, ${intensity})`;
                out.push({ date: key, count, color });
            }
            return out;
        },

        hourTotals() {
            const arr = new Array(24).fill(0);
            // Prefer raw rows so we can compute in the user's LOCAL timezone.
            // Falls back to the rollup (server-tz) only if no raw data is loaded.
            if (this.filteredHistory.length > 0) {
                for (const r of this.filteredHistory) {
                    const h = new Date(r.visit_time).getHours();
                    arr[h] += r.visit_count || 1;
                }
                return arr;
            }
            if (!this.selectedDomain && this.hourlyRows.length) {
                for (const r of this.hourlyRows) {
                    if (this.selectedUserEmail && r.user_email !== this.selectedUserEmail) continue;
                    arr[r.hour] = (arr[r.hour] || 0) + (r.visits || 0);
                }
            }
            return arr;
        },

        get heatmap() {
            const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
            const flagged = Array.from({ length: 7 }, () => new Array(24).fill(0));
            let usedRaw = false;

            // Prefer raw rows so weekday/hour are computed in the user's LOCAL
            // timezone. Falls back to the lifetime rollup (server-tz) only
            // when no raw rows are loaded — e.g. long-window mode.
            if (this.filteredHistory.length > 0) {
                usedRaw = true;
                for (const r of this.filteredHistory) {
                    const dt = new Date(r.visit_time);
                    const w = dt.getDay();      // 0..6 in LOCAL tz
                    const h = dt.getHours();    // 0..23 in LOCAL tz
                    const v = r.visit_count || 1;
                    grid[w][h] += v;
                    if (r.flagged) flagged[w][h] += v;
                }
            } else if (this.hourlyRows.length > 0) {
                for (const r of this.hourlyRows) {
                    if (this.selectedUserEmail && r.user_email !== this.selectedUserEmail) continue;
                    grid[r.weekday][r.hour] += r.visits || 0;
                    flagged[r.weekday][r.hour] += r.flagged_visits || 0;
                }
            }

            const max = Math.max(1, ...grid.flat());
            return {
                grid,
                flagged,
                source: usedRaw ? "window" : "lifetime",
                colorAt(d, h) {
                    const v = grid[d][h];
                    if (v === 0) return "#f4f4f5";
                    const t = 0.12 + 0.88 * (v / max);
                    return `rgba(15, 23, 42, ${t})`;
                },
                flaggedAt(d, h) {
                    return flagged[d][h];
                },
                tooltipAt(d, h) {
                    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
                    return `${days[d]} ${h}:00 — ${grid[d][h]} visits${flagged[d][h] ? `, ${flagged[d][h]} flagged` : ""}`;
                },
            };
        },

        scheduleRender() {
            cancelAnimationFrame(this._raf);
            // Two rAFs: first frame lets Alpine commit any pending DOM
            // updates (x-show toggles, x-for inserts); second frame paints
            // with stable layout. Combined with `animation: false` in
            // chartOptions(), this avoids the "t is null" crash that
            // happened when Chart.js's deferred animation fired against a
            // canvas Alpine had since detached.
            this._raf = requestAnimationFrame(() => {
                this._raf = requestAnimationFrame(() => this.renderAllCharts());
            });
        },

        renderAllCharts() {
            if (this.loading || this.error || !this.authed) return;
            const probe = document.getElementById("dailyChart");
            if (!probe || !probe.offsetParent) return;
            // Detach any existing canvases first — destroy() before re-render.
            Object.values(this.charts).forEach((c) => c?.destroy());
            this.charts = {};
            // Wrap each render in try/catch: one chart failing shouldn't
            // poison the rest, and the whole batch shouldn't kill the page.
            const safeRender = (fn, label) => {
                try { fn.call(this); }
                catch (e) { console.warn(`chart render failed: ${label}`, e); }
            };
            safeRender(this.renderDailyChart, "daily");
            safeRender(this.renderCategoryChart, "category");
            safeRender(this.renderDomainsChart, "domains");
            safeRender(this.renderHourlyChart, "hourly");
            safeRender(this.renderUsersChart, "users");
            safeRender(this.renderDwellChart, "dwell");
        },

        renderDailyChart() {
            const el = document.getElementById("dailyChart");
            if (!el) return;
            const { labels, values } = this.dailyTrend;
            this.charts.daily = new Chart(el, {
                type: "line",
                data: {
                    labels,
                    datasets: [{
                        label: "Visits",
                        data: values,
                        borderColor: ACCENT,
                        backgroundColor: ACCENT_FILL,
                        borderWidth: 1.5,
                        tension: 0.25,
                        fill: true,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    }],
                },
                options: chartOptions({ axis: "y" }),
            });
        },

        renderCategoryChart() {
            const el = document.getElementById("categoryChart");
            if (!el) return;
            const cats = this.categoryMix;
            this.charts.category = new Chart(el, {
                type: "bar",
                data: {
                    labels: cats.map((c) => c.label),
                    datasets: [{
                        label: "Visits",
                        data: cats.map((c) => c.count),
                        backgroundColor: cats.map((c) => CATEGORY_COLORS[c.label] || "#94a3b8"),
                        borderRadius: 3,
                    }],
                },
                options: chartOptions({ axis: "x", indexAxis: "y" }),
            });
        },

        renderDomainsChart() { /* removed in redesign — kept for compat */ },

        renderHourlyChart() {
            const el = document.getElementById("hourlyChart");
            if (!el) return;
            const totals = this.hourTotals();
            this.charts.hourly = new Chart(el, {
                type: "bar",
                data: {
                    labels: totals.map((_, h) => `${h}`),
                    datasets: [{
                        label: "Visits by hour",
                        data: totals,
                        backgroundColor: ACCENT,
                        borderRadius: 2,
                        barPercentage: 0.85,
                        categoryPercentage: 0.85,
                    }],
                },
                options: chartOptions({ axis: "y" }),
            });
        },

        renderUsersChart() {
            const el = document.getElementById("usersChart");
            if (!el) return;
            if (this.selectedUserEmail || this.perUserBreakdown.length <= 1) return;
            const data = this.perUserBreakdown;
            this.charts.users = new Chart(el, {
                type: "bar",
                data: {
                    labels: data.map((d) => d.label),
                    datasets: [{
                        label: "Visits",
                        data: data.map((d) => d.count),
                        backgroundColor: ACCENT,
                        borderRadius: 3,
                    }],
                },
                options: chartOptions({ axis: "x", indexAxis: "y" }),
            });
        },

        renderDwellChart() {
            const el = document.getElementById("dwellChart");
            if (!el || !this.kpis.totalDuration) return;
            const map = new Map();
            if (this.useRollups) {
                for (const r of this.filteredDaily) {
                    map.set(r.category || "other", (map.get(r.category || "other") || 0) + (r.duration_sum || 0));
                }
            } else {
                for (const r of this.filteredHistory) {
                    const c = r.category || "other";
                    map.set(c, (map.get(c) || 0) + (r.duration || 0));
                }
            }
            const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
            this.charts.dwell = new Chart(el, {
                type: "bar",
                data: {
                    labels: entries.map(([k]) => k),
                    datasets: [{
                        label: "Minutes",
                        data: entries.map(([, v]) => Math.round(v / 60)),
                        backgroundColor: entries.map(([k]) => CATEGORY_COLORS[k] || "#94a3b8"),
                        borderRadius: 3,
                    }],
                },
                options: chartOptions({ axis: "x", indexAxis: "y" }),
            });
        },

        exportCsv() {
            if (this.useRollups) {
                const src = this.filteredDaily;
                if (!src.length) return alert("No data to export");
                const headers = ["visit_date", "user_email", "user_id", "domain", "category", "flagged", "visits", "visit_count_sum", "duration_sum", "search_count"];
                const rows = src.map((r) => headers.map((h) => r[h]));
                downloadCsv(headers, rows, "history-daily-rollup");
            } else {
                const src = this.filteredHistory;
                if (!src.length) return alert("No data to export");
                const headers = ["url", "protocol", "domain", "path", "query", "title", "visit_time", "visit_count", "user_email", "user_id", "category", "flagged", "search_query", "duration"];
                const rows = src.map((r) => headers.map((h) => r[h]));
                downloadCsv(headers, rows, "browser-history");
            }
        },

        badgeClass(category) {
            const map = {
                social: "bg-pink-50 text-pink-700 border-pink-200",
                video: "bg-violet-50 text-violet-700 border-violet-200",
                gaming: "bg-indigo-50 text-indigo-700 border-indigo-200",
                news: "bg-teal-50 text-teal-700 border-teal-200",
                adult: "bg-red-50 text-red-700 border-red-200",
                education: "bg-sky-50 text-sky-700 border-sky-200",
                shopping: "bg-orange-50 text-orange-700 border-orange-200",
                search: "bg-cyan-50 text-cyan-700 border-cyan-200",
                productivity: "bg-blue-50 text-blue-700 border-blue-200",
                ai: "bg-emerald-50 text-emerald-700 border-emerald-200",
                other: "bg-neutral-50 text-neutral-600 border-neutral-200",
            };
            return map[category] || map.other;
        },

        fmt(n) { return (n || 0).toLocaleString(); },
        fmtDuration(seconds) {
            if (!seconds) return "n/a";
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
        },
        formatDate(iso) {
            if (!iso) return "";
            const d = new Date(iso);
            return d.toLocaleString();
        },
        trim(str, n) {
            if (!str) return "";
            return str.length > n ? str.substring(0, n) + "…" : str;
        },
    };
}

const PALETTE = [
    "#0f172a","#334155","#64748b","#94a3b8",
    "#1d4ed8","#2563eb","#0891b2","#0d9488",
    "#65a30d","#ca8a04",
];

const CATEGORY_COLORS = {
    social: "#db2777",
    video: "#7c3aed",
    gaming: "#4f46e5",
    news: "#0d9488",
    adult: "#dc2626",
    education: "#0284c7",
    shopping: "#ea580c",
    search: "#0891b2",
    productivity: "#1e40af",
    ai: "#059669",
    other: "#94a3b8",
};

const ACCENT = "#0f172a";
const ACCENT_FILL = "rgba(15, 23, 42, 0.06)";
const GRID_COLOR = "rgba(15, 23, 42, 0.06)";
const TICK_COLOR = "#737373";

function chartOptions({ axis = "y", indexAxis = "x" } = {}) {
    const valueAxis = {
        beginAtZero: true,
        grid: { color: GRID_COLOR, drawBorder: false },
        ticks: { color: TICK_COLOR, font: { size: 11, family: "Inter, system-ui, sans-serif" } },
        border: { display: false },
    };
    const labelAxis = {
        grid: { display: false, drawBorder: false },
        ticks: { color: TICK_COLOR, font: { size: 11, family: "Inter, system-ui, sans-serif" } },
        border: { display: false },
    };
    return {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis,
        // Animations + the ResizeObserver-driven resize loop both call
        // chart.draw() on a deferred frame. If anything (Alpine re-render,
        // canvas swap) detaches the canvas in the meantime, the next frame
        // crashes with "t is null". Disable animation; resize is still safe.
        animation: false,
        animations: { colors: false, x: false, y: false },
        transitions: { active: { animation: { duration: 0 } } },
        // Debounce ResizeObserver-triggered redraws so a flurry of layout
        // shifts (font load, x-show toggles) collapses into one safe redraw.
        resizeDelay: 100,
        plugins: {
            legend: { display: false },
            tooltip: {
                animation: false,
                backgroundColor: "#0f172a",
                titleColor: "#fff",
                bodyColor: "#fff",
                titleFont: { size: 11, weight: "600", family: "Inter, system-ui, sans-serif" },
                bodyFont: { size: 11, family: "Inter, system-ui, sans-serif" },
                padding: 10,
                displayColors: false,
                cornerRadius: 6,
            },
        },
        scales: axis === "y"
            ? { y: valueAxis, x: labelAxis }
            : { x: valueAxis, y: labelAxis },
    };
}

function escapeFilter(value) {
    return String(value).replace(/"/g, '\\"');
}

function aggregateTotals(rows) {
    if (!rows || !rows.length) return null;
    const out = {
        user_email: rows[0].user_email,
        total_visits: 0,
        total_duration: 0,
        total_flagged: 0,
        total_searches: 0,
        unique_domains: 0, // approximate (sum across devices)
        first_seen: rows[0].first_seen,
        last_seen: rows[0].last_seen,
        device_count: rows.length,
    };
    for (const r of rows) {
        out.total_visits += Number(r.total_visits) || 0;
        out.total_duration += Number(r.total_duration) || 0;
        out.total_flagged += Number(r.total_flagged) || 0;
        out.total_searches += Number(r.total_searches) || 0;
        out.unique_domains += Number(r.unique_domains) || 0;
        if (r.first_seen && (!out.first_seen || r.first_seen < out.first_seen)) out.first_seen = r.first_seen;
        if (r.last_seen && (!out.last_seen || r.last_seen > out.last_seen)) out.last_seen = r.last_seen;
    }
    return out;
}

function localDateKey(d) {
    // YYYY-MM-DD in the browser's local timezone (matches what users see
    // when they think "yesterday" / "today" in their own context).
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function isoForFilter(date) {
    return date.toISOString().replace("T", " ").replace("Z", "");
}

function addDays(date, days) {
    return new Date(date.getTime() + days * 86400000);
}

function downloadCsv(headers, rows, baseName) {
    const csv = [headers, ...rows]
        .map((r) => r.map((c) => `"${(c ?? "").toString().replace(/"/g, '""')}"`).join(","))
        .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}-${new Date().toISOString().substring(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

window.dashboard = dashboard;
