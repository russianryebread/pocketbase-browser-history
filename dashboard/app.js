let historyData = [];
let charts = {};
let pb = null;

// Load from saved token, if available
document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("username").focus();
    initializePocketBase();
    if (pb) {
      await loadData()
    }
});

function initializePocketBase() {
    pb = new PocketBase("https://az.hoshor.me:8001");
}

async function authenticate() {
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    if (!username || !password) {
        showError("Please enter username and password");
        return;
    }

    initializePocketBase();

    document.getElementById("loadingIndicator").textContent = "Authenticating...";
    document.getElementById("errorMessage").style.display = "none";

    try {
        const auth = await pb
            .collection("users")
            .authWithPassword(username, password);
        console.log("Auth", username, password, auth);
        await loadData();
    } catch (userError) {
        console.error(userError);
        showError(`Authentication failed: ${userError.message}`);
    }
}

async function logout() {
    if (pb) {
        pb.authStore.clear();
        document.getElementById("analyticsContent").style.display =
            "none";
        document.getElementById("loadingIndicator").textContent =
            'Enter credentials and click "Login & Load Data" to begin analysis';
        document.getElementById("loadingIndicator").style.display =
            "block";

        // Clear form
        document.getElementById("username").value = "";
        document.getElementById("password").value = "";

        document.getElementById("loginForm").style.display = "flex";
    }
}

async function loadData() {
    if (!pb || !pb.authStore.isValid) {
        showError("Please authenticate first");
        return;
    }

    document.getElementById("loginForm").style.display = "none";

    const collectionName = "history";
    const userFilter = document.getElementById("userFilter").value;

    document.getElementById("loadingIndicator").textContent = "Loading data...";
    document.getElementById("errorMessage").style.display = "none";
    document.getElementById("analyticsContent").style.display = "none";

    try {
        let filter = "";
        if (userFilter) {
            filter = `user_email="${userFilter}"`;
        }

        const records = await pb
            .collection(collectionName)
            .getFullList({
                sort: "-visit_time",
                filter: filter,
            });

        historyData = records || [];

        if (historyData.length === 0) {
            throw new Error("No data found");
        }

        renderAnalytics();
        document.getElementById("loadingIndicator").style.display = "none";
        document.getElementById("analyticsContent").style.display = "block";
    } catch (error) {
        showError(`Error loading data: ${error.message}`);
    }
}

function showError(message) {
    document.getElementById("errorMessage").textContent = message;
    document.getElementById("errorMessage").style.display = "block";
    document.getElementById("loadingIndicator").style.display =
        "none";
}

function renderAnalytics() {
    renderStats();
    renderInsights();
    renderCharts();
    renderTopSites();
}

function renderStats() {
    const totalVisits = historyData.reduce(
        (sum, item) => sum + (item.visit_count || 1),
        0,
    );
    const uniqueSites = new Set(historyData.map((item) => item.url))
        .size;
    const activeUsers = new Set(
        historyData.map((item) => item.user_id || item.user_email),
    ).size;

    const dateRange = getDateRange();
    const avgDaily = Math.round(
        totalVisits / Math.max(1, dateRange),
    );

    document.getElementById("totalVisits").textContent =
        totalVisits.toLocaleString();
    document.getElementById("uniqueSites").textContent =
        uniqueSites.toLocaleString();
    document.getElementById("activeUsers").textContent =
        activeUsers.toLocaleString();
    document.getElementById("avgDaily").textContent =
        avgDaily.toLocaleString();
}

function renderInsights() {
    const insights = generateInsights();
    const container = document.getElementById("insightsContainer");
    container.innerHTML = insights
        .map(
            (insight) => `
    <div class="insight-item">
        <h4>${insight.title}</h4>
        <p>${insight.description}</p>
    </div>
`,
        )
        .join("");
}

function generateInsights() {
    const insights = [];

    // Peak usage hour
    const hourlyData = getHourlyData();
    const peakHour = Object.keys(hourlyData).reduce((a, b) =>
        hourlyData[a] > hourlyData[b] ? a : b,
    );
    insights.push({
        title: "Peak Usage Time",
        description: `Most active at ${peakHour}:00 with ${hourlyData[peakHour]} visits`,
    });

    // Most productive day
    const dailyData = getDailyData();
    const dates = Object.keys(dailyData).sort(
        (a, b) => dailyData[b] - dailyData[a],
    );
    if (dates.length > 0) {
        insights.push({
            title: "Most Active Day",
            description: `${dates[0]} with ${dailyData[dates[0]]} visits`,
        });
    }

    // Domain diversity
    const domains = getDomainData();
    const topDomain = Object.keys(domains)[0];
    const domainPercentage = Math.round(
        (domains[topDomain] / historyData.length) * 100,
    );
    insights.push({
        title: "Browse Diversity",
        description: `Top domain (${topDomain}) represents ${domainPercentage}% of all visits`,
    });

    // Usage pattern
    const weekendVisits = historyData.filter((item) => {
        const date = new Date(item.visit_time);
        const day = date.getDay();
        return day === 0 || day === 6;
    }).length;
    const weekdayVisits = historyData.length - weekendVisits;
    const ratio = Math.round(
        weekdayVisits / Math.max(1, weekendVisits),
    );
    insights.push({
        title: "Work-Life Pattern",
        description: `${ratio}x more active on weekdays vs weekends`,
    });

    return insights;
}

function renderCharts() {
    // Destroy existing charts
    Object.values(charts).forEach((chart) => chart?.destroy());

    renderDailyChart();
    renderHourlyChart();
    renderDomainsChart();
    renderUsersChart();
}

function renderDailyChart() {
    const ctx = document
        .getElementById("dailyChart")
        .getContext("2d");
    const dailyData = getDailyData();
    const dates = Object.keys(dailyData).sort();

    charts.daily = new Chart(ctx, {
        type: "line",
        data: {
            labels: dates,
            datasets: [
                {
                    label: "Daily Visits",
                    data: dates.map((date) => dailyData[date]),
                    borderColor: "#667eea",
                    backgroundColor: "rgba(102, 126, 234, 0.1)",
                    tension: 0.4,
                    fill: true,
                },
            ],
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true },
            },
        },
    });
}

function renderHourlyChart() {
    const ctx = document
        .getElementById("hourlyChart")
        .getContext("2d");
    const hourlyData = getHourlyData();
    const hours = Array.from({ length: 24 }, (_, i) => i);

    charts.hourly = new Chart(ctx, {
        type: "bar",
        data: {
            labels: hours.map((h) => `${h}:00`),
            datasets: [
                {
                    label: "Visits by Hour",
                    data: hours.map((h) => hourlyData[h] || 0),
                    backgroundColor: "rgba(118, 75, 162, 0.8)",
                },
            ],
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true },
            },
        },
    });
}

function renderDomainsChart() {
    const ctx = document
        .getElementById("domainsChart")
        .getContext("2d");
    const domains = getDomainData();
    const topDomains = Object.entries(domains).slice(0, 10);

    charts.domains = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: topDomains.map(([domain]) => domain),
            datasets: [
                {
                    data: topDomains.map(([_, count]) => count),
                    backgroundColor: [
                        "#667eea",
                        "#764ba2",
                        "#f093fb",
                        "#f5576c",
                        "#4ecdc4",
                        "#45b7d1",
                        "#96ceb4",
                        "#ffecd2",
                        "#fcb69f",
                        "#a8edea",
                    ],
                },
            ],
        },
        options: {
            responsive: true,
        },
    });
}

function renderUsersChart() {
    const ctx = document
        .getElementById("usersChart")
        .getContext("2d");
    const userData = getUserData();
    const users = Object.entries(userData).slice(0, 10);

    charts.users = new Chart(ctx, {
        type: "bar",
        data: {
            labels: users.map(
                ([user]) => user.substring(0, 20) + "...",
            ),
            datasets: [
                {
                    label: "Visits per User",
                    data: users.map(([_, count]) => count),
                    backgroundColor: "rgba(102, 126, 234, 0.8)",
                },
            ],
        },
        options: {
            responsive: true,
            indexAxis: "y",
            scales: {
                x: { beginAtZero: true },
            },
        },
    });
}

function renderTopSites() {
    const siteData = {};
    historyData.forEach((item) => {
        siteData[item.url] =
            (siteData[item.url] || 0) + (item.visit_count || 1);
    });

    const topSites = Object.entries(siteData)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20);

    const container = document.getElementById("topSitesList");
    container.innerHTML = topSites
        .map(
            ([url, count]) => `
    <div class="site-item">
        <div class="site-url">${url.length > 60 ? url.substring(0, 60) + "..." : url}</div>
        <div class="site-count">${count}</div>
    </div>
`,
        )
        .join("");
}

function getDailyData() {
    const daily = {};
    historyData.forEach((item) => {
        const date = new Date(item.visit_time)
            .toISOString()
            .split("T")[0];
        daily[date] = (daily[date] || 0) + (item.visit_count || 1);
    });
    return daily;
}

function getHourlyData() {
    const hourly = {};
    historyData.forEach((item) => {
        const hour = new Date(item.visit_time).getHours();
        hourly[hour] =
            (hourly[hour] || 0) + (item.visit_count || 1);
    });
    return hourly;
}

function getDomainData() {
    const domains = {};
    historyData.forEach((item) => {
        try {
            const domain = new URL(item.url).hostname;
            domains[domain] =
                (domains[domain] || 0) + (item.visit_count || 1);
        } catch (e) {
            domains["Unknown"] =
                (domains["Unknown"] || 0) + (item.visit_count || 1);
        }
    });
    return Object.entries(domains)
        .sort(([, a], [, b]) => b - a)
        .reduce(
            (obj, [domain, count]) => ({ ...obj, [domain]: count }),
            {},
        );
}

function getUserData() {
    const users = {};
    historyData.forEach((item) => {
        const user = item.user_email || item.user_id || "Unknown";
        users[user] = (users[user] || 0) + (item.visit_count || 1);
    });
    return Object.entries(users)
        .sort(([, a], [, b]) => b - a)
        .reduce(
            (obj, [user, count]) => ({ ...obj, [user]: count }),
            {},
        );
}

function getDateRange() {
    if (historyData.length === 0) return 1;
    const dates = historyData.map(
        (item) => new Date(item.visit_time),
    );
    const min = Math.min(...dates);
    const max = Math.max(...dates);
    return Math.ceil((max - min) / (1000 * 60 * 60 * 24)) || 1;
}

function exportData() {
    if (historyData.length === 0) {
        alert("No data to export");
        return;
    }

    const csv = [
        [
            "URL",
            "Title",
            "Visit Time",
            "Visit Count",
            "User Email",
            "User ID",
        ],
        ...historyData.map((item) => [
            item.url,
            item.title,
            item.visit_time,
            item.visit_count,
            item.user_email || "",
            item.user_id || "",
        ]),
    ]
        .map((row) => row.map((cell) => `"${cell}"`).join(","))
        .join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `browser-history-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
