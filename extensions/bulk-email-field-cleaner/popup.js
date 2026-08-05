const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const exportBtn = document.getElementById('exportBtn');
const refreshBtn = document.getElementById('refreshBtn');

function fmtState(data) {
  const state = data.state || { phase: 'idle' };
  const logs = data.logs || [];
  const success = logs.filter(x => x.status === 'SUCCESS').length;
  const skipped = logs.filter(x => x.status === 'SKIPPED').length;
  const failed = logs.filter(x => x.status === 'FAIL').length;
  return [
    `Phase: ${state.phase || 'idle'}`,
    state.message ? `Message: ${state.message}` : null,
    state.currentIndex != null && state.total != null ? `Progress: ${state.currentIndex}/${state.total}` : null,
    `Success: ${success}`,
    `Skipped: ${skipped}`,
    `Fail: ${failed}`
  ].filter(Boolean).join('\n');
}

async function refresh() {
  const data = await chrome.storage.local.get(['state', 'logs']);
  statusEl.textContent = fmtState(data);
}

startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ type: 'START', tabId: tab.id });
  await refresh();
});

refreshBtn.addEventListener('click', refresh);

exportBtn.addEventListener('click', async () => {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'client-email-removal-log.json';
  a.click();
  URL.revokeObjectURL(url);
});

chrome.storage.onChanged.addListener(() => refresh());
refresh();
