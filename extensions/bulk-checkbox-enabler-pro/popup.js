const status = document.getElementById('status');
function log(msg) { status.textContent = msg; }
async function send(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const delayMs = Number(document.getElementById('delayMs').value || 1200);
  const stopOnError = document.getElementById('stopOnError').checked;
  chrome.runtime.sendMessage({ type, tabId: tab?.id, url: tab?.url, delayMs, stopOnError }, (res) => {
    if (chrome.runtime.lastError) return log('Error: ' + chrome.runtime.lastError.message);
    log(res?.message || 'Sent.');
  });
}
document.getElementById('runCurrent').onclick = () => send('START_FROM_ORG');
document.getElementById('resume').onclick = () => send('RESUME');
document.getElementById('stop').onclick = () => send('STOP');
document.getElementById('exportCsv').onclick = () => send('EXPORT_CSV');
document.getElementById('clear').onclick = () => send('CLEAR');
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'STATUS') log(msg.message); });
send('GET_STATUS');
