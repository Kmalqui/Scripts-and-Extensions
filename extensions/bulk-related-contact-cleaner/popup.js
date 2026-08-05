async function refreshStatus() {
  const statusDiv = document.getElementById('status');
  const data = await chrome.storage.local.get(['runState', 'logs']);
  const logs = data.logs || [];
  const state = data.runState || { running: false, currentIndex: 0, total: 0, lastMessage: 'Ready.' };
  const success = logs.filter(x => x.status === 'SUCCESS').length;
  const skipped = logs.filter(x => x.status === 'SKIPPED').length;
  const failed = logs.filter(x => x.status === 'FAIL').length;
  statusDiv.textContent = [
    state.lastMessage || 'Ready.',
    `Running: ${state.running ? 'Yes' : 'No'}`,
    `Progress: ${state.currentIndex || 0}/${state.total || 0}`,
    `Success: ${success}`,
    `Skipped: ${skipped}`,
    `Failed: ${failed}`
  ].join('\n');
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const email = document.getElementById('emailInput').value.trim();
  if (!email) {
    document.getElementById('status').textContent = 'Please enter an assistant email to remove.';
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: 'START_PROCESS', tabId: tab.id, emailToRemove: email }, async () => {
    await refreshStatus();
    if (chrome.runtime.lastError) {
      document.getElementById('status').textContent = chrome.runtime.lastError.message;
    }
  });
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['logs']);
  const logs = data.logs || [];
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `remove-assistant-logs-${Date.now()}.json`, saveAs: true });
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ logs: [], links: [], runState: { running: false, currentIndex: 0, total: 0, lastMessage: 'Cleared.' } });
  refreshStatus();
});

chrome.storage.onChanged.addListener(() => refreshStatus());
refreshStatus();
