let running = false;
let paused = false;
let sourceTabId = null;
let clientUrls = [];
let index = 0;
let logs = [];
let delayMs = 1200;
let stopOnError = true;

const STORAGE_KEY = 'clientCheckboxRunnerStateV4';
const CHECKBOXES = [
  { id: 'requiredOptionOne', label: 'requiredOptionOne' },
  { id: 'requiredOptionTwo', label: 'requiredOptionTwo' },
  { id: 'requiredOptionThree', label: 'requiredOptionThree' }
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function status(message) { chrome.runtime.sendMessage({ type: 'STATUS', message }).catch(() => {}); }

async function saveState(extra = {}) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      clientUrls, index, logs, running, paused, delayMs, stopOnError,
      updatedAt: new Date().toISOString(),
      ...extra
    }
  });
}
async function loadState() { return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]; }
async function clearState() { await chrome.storage.local.remove(STORAGE_KEY); }

function summaryText() {
  const updated = logs.filter(l => l.status === 'SUCCESS').length;
  const skipped = logs.filter(l => l.status === 'SKIPPED').length;
  const failed = logs.filter(l => l.status === 'FAIL').length;
  return `Progress: ${logs.length}/${clientUrls.length}\nUpdated: ${updated}\nSkipped: ${skipped}\nFailed: ${failed}\nNext index: ${index + 1}`;
}

async function inject(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'START_FROM_ORG') {
        running = true; paused = false; sourceTabId = msg.tabId; index = 0; logs = [];
        delayMs = Math.max(500, Number(msg.delayMs || 1200));
        stopOnError = msg.stopOnError !== false;
        status('Collecting record links from current listing page...');
        clientUrls = await collectAllClientUrls(sourceTabId);
        if (!clientUrls.length) {
          running = false;
          sendResponse({ message: 'No record links found. Make sure you are on the org/record list page.' });
          return;
        }
        await saveState({ lastMessage: 'Started new run' });
        status(`Found ${clientUrls.length} client(s). Starting...\n${summaryText()}`);
        processNextClient();
        sendResponse({ message: `Found ${clientUrls.length} client(s). Running...` });
        return;
      }
      if (msg.type === 'RESUME') {
        const s = await loadState();
        if (!s || !s.clientUrls?.length) { sendResponse({ message: 'No saved run found to resume.' }); return; }
        ({ clientUrls = [], index = 0, logs = [], delayMs = 1200, stopOnError = true } = s);
        running = true; paused = false;
        await saveState({ lastMessage: 'Resumed run' });
        status('Resumed saved run.\n' + summaryText());
        processNextClient();
        sendResponse({ message: 'Resumed. ' + summaryText() });
        return;
      }
      if (msg.type === 'STOP') {
        running = false; paused = true;
        await saveState({ lastMessage: 'Stopped by user' });
        status('Stopped. You can resume later.\n' + summaryText());
        sendResponse({ message: 'Stopped. Resume is available.' });
        return;
      }
      if (msg.type === 'CLEAR') {
        running = false; paused = false; clientUrls = []; index = 0; logs = [];
        await clearState();
        status('Cleared saved run/logs.');
        sendResponse({ message: 'Cleared saved run/logs.' });
        return;
      }
      if (msg.type === 'GET_STATUS') {
        const s = await loadState();
        sendResponse({ message: s ? `Saved run found. ${s.logs?.length || 0}/${s.clientUrls?.length || 0} processed. Last update: ${s.updatedAt}` : 'Ready. No saved run.' });
        return;
      }
      if (msg.type === 'EXPORT_CSV') {
        await exportCsv();
        sendResponse({ message: 'CSV export downloaded.' });
        return;
      }
    } catch (err) {
      status('Error: ' + err.message);
      sendResponse({ message: 'Error: ' + err.message });
    }
  })();
  return true;
});

async function collectAllClientUrls(tabId) {
  const firstBatch = await inject(tabId, () => {
    const abs = href => new URL(href, location.href).href;
    const setPageSize = () => {
      const pageSize = document.querySelector('#pageSize, select[name="pageSize"], select[id*="PageSize" i]');
      if (pageSize && pageSize.value !== '100') {
        pageSize.value = '100';
        pageSize.dispatchEvent(new Event('change', { bubbles: true }));
        const reload = document.querySelector('#resultsContainer, input[id*="Reload" i], button[id*="Reload" i]');
        if (reload) reload.click();
      }
    };
    const collect = () => Array.from(document.querySelectorAll([
      "a._popup[href*='show-record']",
      "a[href*='/records/'][href*='show-record']",
      "a[href*='show-record']",
      "a[href*='recordId']",
      "a[href*='client']"
    ].join(','))).map(a => a.href).filter(Boolean).map(abs);
    setPageSize();
    return collect();
  });
  await sleep(1500);
  const all = new Set(firstBatch || []);
  let guard = 0;
  while (running && guard++ < 100) {
    const result = await inject(tabId, () => {
      const abs = href => new URL(href, location.href).href;
      const collect = () => Array.from(document.querySelectorAll([
        "a._popup[href*='show-record']",
        "a[href*='/records/'][href*='show-record']",
        "a[href*='show-record']",
        "a[href*='recordId']",
        "a[href*='client']"
      ].join(','))).map(a => a.href).filter(Boolean).map(abs);
      const before = collect();
      const candidates = Array.from(document.querySelectorAll('#pagination a, .pagination a, a, button, input[type="button"], input[type="submit"]'));
      const next = candidates.find(el => {
        const text = ((el.innerText || el.value || el.title || el.getAttribute('aria-label') || '') + '').trim().toLowerCase();
        const cls = (el.className || '').toString().toLowerCase();
        const disabled = el.disabled || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true';
        if (disabled) return false;
        return text === 'next' || text === '>' || text === '»' || text.includes('next') || cls.includes('next');
      });
      if (next) { next.click(); return { clickedNext: true, urls: before }; }
      return { clickedNext: false, urls: before };
    });
    (result?.urls || []).forEach(u => all.add(u));
    if (!result?.clickedNext) break;
    await sleep(1200);
  }
  return Array.from(all);
}

async function processNextClient() {
  if (!running || paused) return;
  if (index >= clientUrls.length) {
    running = false; paused = false;
    await saveState({ lastMessage: 'Completed' });
    status('Done.\n' + summaryText());
    return;
  }
  const url = clientUrls[index];
  const row = { url, startedAt: new Date().toISOString(), status: 'FAIL', details: '' };
  status(`Processing ${index + 1}/${clientUrls.length}\n${url}`);
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabLoad(tab.id);
    await sleep(1000);
    const result = await inject(tab.id, clientPageWorker, [CHECKBOXES]);
    Object.assign(row, result, { finishedAt: new Date().toISOString() });
    logs.push(row);
    index++;
    await saveState({ lastMessage: row.status });
    status(`${row.status}: ${index}/${clientUrls.length}\n${row.details || ''}\n\n${summaryText()}`);
    if (row.status === 'FAIL' && stopOnError) {
      running = false; paused = true;
      await saveState({ lastMessage: 'Stopped on error' });
      status(`Stopped on error at client ${index}/${clientUrls.length}.\n${row.details}\n\nFix/check the page, then Resume or Clear.`);
      return;
    }
  } catch (err) {
    row.status = 'FAIL'; row.details = err.message; row.finishedAt = new Date().toISOString();
    logs.push(row); index++;
    await saveState({ lastMessage: 'Error: ' + err.message });
    status(`FAIL: ${err.message}\n\n${summaryText()}`);
    if (stopOnError) { running = false; paused = true; return; }
  } finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
  await sleep(delayMs);
  processNextClient();
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 20000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function clientPageWorker(checkboxes) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const clickReal = el => {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
    return true;
  };
  const findButton = (kind) => {
    const ids = kind === 'edit'
      ? ['#edit-record-button', '#edit-record-button', '#editButton', '#EditButton']
      : ['#save-record-button', '#save-record-button', '#saveButton', '#SaveButton'];
    for (const sel of ids) { const el = document.querySelector(sel); if (visible(el)) return el; }
    const words = kind === 'edit' ? ['edit'] : ['save', 'update'];
    return Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
      .find(el => visible(el) && words.includes(((el.innerText || el.value || el.title || '') + '').trim().toLowerCase()));
  };
  const getBox = id => document.getElementById(id) || document.querySelector(`input[name="${id}"]`);
  return (async () => {
    const before = checkboxes.map(c => ({ id: c.id, found: !!getBox(c.id), checked: !!getBox(c.id)?.checked, disabled: !!getBox(c.id)?.disabled }));
    if (!before.every(x => x.found)) return { status: 'FAIL', details: 'Missing checkbox(es): ' + before.filter(x => !x.found).map(x => x.id).join(', ') };
    if (before.every(x => x.checked)) return { status: 'SKIPPED', details: 'Already enabled.' };
    const edit = findButton('edit');
    if (!edit) return { status: 'FAIL', details: 'Edit button not found.' };
    clickReal(edit);
    await sleep(1200);
    let changed = false; const changedBoxes = [];
    for (const c of checkboxes) {
      const box = getBox(c.id);
      if (!box) continue;
      if (!box.checked) {
        if (box.disabled) box.disabled = false;
        clickReal(box);
        await sleep(250);
        if (!box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
        changed = true; changedBoxes.push(c.id);
      }
    }
    if (!changed) return { status: 'SKIPPED', details: 'Already enabled after Edit.' };
    await sleep(500);
    const save = findButton('save');
    if (!save) return { status: 'FAIL', details: 'Changed but Save button not found. Changed: ' + changedBoxes.join(', ') };
    clickReal(save);
    await sleep(1600);
    return { status: 'SUCCESS', details: 'Enabled and saved: ' + changedBoxes.join(', ') };
  })();
}

async function exportCsv() {
  const s = await loadState();
  const rows = (logs.length ? logs : (s?.logs || []));
  const headers = ['status','url','details','startedAt','finishedAt'];
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
  const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await chrome.downloads.download({ url, filename: `client-checkbox-results-${stamp}.csv`, saveAs: true });
}
