const POCKETBASE_URL = 'https://az.hoshor.me:8001'
const COLLECTION_NAME = 'history'

document.addEventListener('DOMContentLoaded', async () => {
  const urlInput = document.getElementById('pocketbaseUrl');
  const emailInput = document.getElementById('userEmail');
  const userIdInput = document.getElementById('userId');
  const saveBtn = document.getElementById('saveConfig');
  const syncBtn = document.getElementById('syncNow');
  const testBtn = document.getElementById('testConnection');
  const status = document.getElementById('status');

  // Load saved config
  const config = await browser.storage.local.get(['pocketbaseUrl', 'collectionName', 'userEmail', 'userId']);
  urlInput.value = config.pocketbaseUrl || POCKETBASE_URL;
  emailInput.value = config.userEmail || '';
  userIdInput.value = config.userId || generateUniqueId();

  // Generate unique ID if none exists
  if (!config.userId) {
    const newId = generateUniqueId();
    userIdInput.value = newId;
    await browser.storage.local.set({ userId: newId });
  }

  // Save configuration
  saveBtn.addEventListener('click', async () => {
    await browser.storage.local.set({
      pocketbaseUrl: urlInput.value,
      collectionName: COLLECTION_NAME,
      userEmail: emailInput.value
    });
    showStatus('Configuration saved!', 'success');
  });

  // Sync now
  syncBtn.addEventListener('click', async () => {
    showStatus('Syncing...', 'success');
    try {
      await browser.runtime.sendMessage({ action: 'syncNow' });
      showStatus('Sync completed!', 'success');
    } catch (error) {
      showStatus('Sync failed: ' + error.message, 'error');
    }
  });

  // Test connection
  testBtn.addEventListener('click', async () => {
    showStatus('Testing connection...', 'success');
    try {
      const response = await fetch(`${urlInput.value}/api/health`);
      if (response.ok) {
        showStatus('Connection successful!', 'success');
      } else {
        showStatus('Connection failed - check URL', 'error');
      }
    } catch (error) {
      showStatus('Connection failed: ' + error.message, 'error');
    }
  });

  function showStatus(message, type) {
    status.textContent = message;
    status.className = `status ${type}`;
    setTimeout(() => {
      status.textContent = '';
      status.className = '';
    }, 3000);
  }

  function generateUniqueId() {
    return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
});
