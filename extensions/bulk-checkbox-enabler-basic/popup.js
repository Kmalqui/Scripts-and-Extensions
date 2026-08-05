const status = document.getElementById('status');

function log(msg) {
  status.textContent = msg;
}

async function send(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type, tabId: tab.id, url: tab.url }, (res) => {
    if (chrome.runtime.lastError) return log('Error: ' + chrome.runtime.lastError.message);
    log(res?.message || 'Sent.');
  });
}

document.getElementById('runCurrent').onclick = () => send('START_FROM_ORG');
document.getElementById('stop').onclick = () => send('STOP');
document.getElementById('exportLog').onclick = () => send('EXPORT_LOG');

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS') log(msg.message);
});
