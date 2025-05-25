// Configuration
const POCKETBASE_URL = 'https://az.hoshor.me:8001';
const COLLECTION_NAME = 'history';

// Track last sync timestamp
let lastSyncTime = 0;

// Initialize on install
browser.runtime.onInstalled.addListener(async () => {
  const result = await browser.storage.local.get(['lastSyncTime']);
  lastSyncTime = result.lastSyncTime || Date.now();
});

// Listen for syncNow message
browser.runtime.onMessage.addListener((message) => {
  if (message.action === 'syncNow') {
    console.log("Manually syncing history...")
    syncHistory();
  }
});

// Listen for browser history changes
// browser.history.onVisited.addListener((historyItem) => {
//   // Save immediately on visit
//   saveToPageBase(historyItem, getConfig());
// });

// Sync history every 1 minute
setInterval(syncHistory, 1 * 60 * 1000);

// Also sync when browser starts
browser.runtime.onStartup.addListener(syncHistory);

async function syncHistory() {
  try {
    const config = await getConfig();
    if (!config.apiUrl || !config.collectionName) {
      console.log('PocketBase not configured');
      return;
    }

    const history = await browser.history.search({
      text: '',
      startTime: lastSyncTime,
      maxResults: 1000
    });

    if (history.length === 0) return;

    for (const item of history) {
      await saveToPageBase(item, config);
    }

    lastSyncTime = Date.now();
    await browser.storage.local.set({ lastSyncTime });
    
    console.log(`Synced ${history.length} history items`);
  } catch (error) {
    console.error('Sync failed:', error);
  }
}

async function saveToPageBase(historyItem, config) {
  const data = {
    url: historyItem.url,
    title: historyItem.title || 'Untitled',
    visit_time: new Date(historyItem.lastVisitTime).toISOString(),
    visit_count: historyItem.visitCount || 1,
    user_email: config.userEmail || '',
    user_id: config.userId || generateUniqueId()
  };

  try {
    const response = await fetch(`${config.apiUrl}/api/collections/${config.collectionName}/records`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (error) {
    console.error('Failed to save to PocketBase:', error);
  }
}

async function getConfig() {
  const result = await browser.storage.local.get(['pocketbaseUrl', 'collectionName', 'userEmail', 'userId']);
  return {
    apiUrl: result.pocketbaseUrl || POCKETBASE_URL,
    collectionName: result.collectionName || COLLECTION_NAME,
    userEmail: result.userEmail || '',
    userId: result.userId || generateUniqueId()
  };
}

function generateUniqueId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}