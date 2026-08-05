let running = false;
let sourceTabId = null;
let clientUrls = [];
let index = 0;
let logs = [];

const CHECKBOXES = [
  { id: 'requiredOptionOne', label: 'requiredOptionOne' },
  { id: 'requiredOptionTwo', label: 'requiredOptionTwo' },
  { id: 'requiredOptionThree', label: 'requiredOptionThree' }
];

function status(message) {
  chrome.runtime.sendMessage({ type: 'STATUS', message }).catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function inject(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'STOP') {
      running = false;
      status('Stopped.');
      sendResponse({ message: 'Stopped.' });
      return;
    }

    if (msg.type === 'EXPORT_LOG') {
      const text = JSON.stringify(logs, null, 2);
      await chrome.storage.local.set({ clientCheckboxLogs: logs });
      status(text || 'No logs yet.');
      sendResponse({ message: text || 'No logs yet.' });
      return;
    }

    if (msg.type === 'START_FROM_ORG') {
      running = true;
      sourceTabId = msg.tabId;
      index = 0;
      logs = [];
      status('Collecting record links from current page...');

      clientUrls = await collectAllClientUrls(sourceTabId);
      if (!clientUrls.length) {
        running = false;
        sendResponse({ message: 'No record links found. Make sure you are on the org/record list page.' });
        return;
      }

      status(`Found ${clientUrls.length} client(s). Starting...`);
      processNextClient();
      sendResponse({ message: `Found ${clientUrls.length} client(s). Running...` });
      return;
    }
  })();
  return true;
});

async function collectAllClientUrls(tabId) {
  // Uses the older working extension pattern: page size, reload, pagination, a._popup/client details links.
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
    ].join(',')))
      .map(a => a.href)
      .filter(Boolean)
      .map(abs);

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
      ].join(',')))
        .map(a => a.href)
        .filter(Boolean)
        .map(abs);

      const before = collect();

      // Try common next-page controls. Older extension used pagination/resultsContainer patterns.
      const candidates = Array.from(document.querySelectorAll('#pagination a, .pagination a, a, button, input[type="button"], input[type="submit"]'));
      const next = candidates.find(el => {
        const text = ((el.innerText || el.value || el.title || el.getAttribute('aria-label') || '') + '').trim().toLowerCase();
        const cls = (el.className || '').toString().toLowerCase();
        const disabled = el.disabled || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true';
        if (disabled) return false;
        return text === 'next' || text === '>' || text === '»' || text.includes('next') || cls.includes('next');
      });

      if (next) {
        next.click();
        return { clickedNext: true, urls: before };
      }
      return { clickedNext: false, urls: before };
    });

    (result?.urls || []).forEach(u => all.add(u));
    if (!result?.clickedNext) break;
    await sleep(1200);
  }

  return Array.from(all);
}

async function processNextClient() {
  if (!running) return;
  if (index >= clientUrls.length) {
    running = false;
    const summary = logs.map(l => `${l.status}: ${l.url} ${l.details || ''}`).join('\n');
    status(`Done. Processed ${logs.length}/${clientUrls.length}.\n\n${summary}`);
    return;
  }

  const url = clientUrls[index++];
  status(`Processing ${index}/${clientUrls.length}\n${url}`);

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabLoad(tab.id);
    await sleep(1000);

    const result = await inject(tab.id, clientPageWorker, [CHECKBOXES]);
    logs.push({ url, ...result });
    status(`Processed ${index}/${clientUrls.length}: ${result.status}\n${result.details || ''}`);
  } catch (err) {
    logs.push({ url, status: 'FAIL', details: err.message });
    status(`Failed ${index}/${clientUrls.length}: ${err.message}`);
  } finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
    await sleep(700);
    processNextClient();
  }
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
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

    for (const sel of ids) {
      const el = document.querySelector(sel);
      if (visible(el)) return el;
    }

    const words = kind === 'edit' ? ['edit'] : ['save', 'update'];
    return Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
      .find(el => visible(el) && words.includes(((el.innerText || el.value || el.title || '') + '').trim().toLowerCase()));
  };

  const getBox = id => document.getElementById(id) || document.querySelector(`input[name="${id}"]`);

  return (async () => {
    const before = checkboxes.map(c => ({ id: c.id, found: !!getBox(c.id), checked: !!getBox(c.id)?.checked, disabled: !!getBox(c.id)?.disabled }));

    const allFound = before.every(x => x.found);
    if (!allFound) return { status: 'FAIL', details: 'Missing checkbox(es): ' + before.filter(x => !x.found).map(x => x.id).join(', ') };

    if (before.every(x => x.checked)) {
      return { status: 'SKIPPED', details: 'Already enabled.' };
    }

    const edit = findButton('edit');
    if (!edit) return { status: 'FAIL', details: 'Edit button not found.' };
    clickReal(edit);
    await sleep(1200);

    let changed = false;
    const changedBoxes = [];

    for (const c of checkboxes) {
      const box = getBox(c.id);
      if (!box) continue;

      if (!box.checked) {
        if (box.disabled) box.disabled = false;
        clickReal(box);
        await sleep(250);

        // Fallback if onclick did not flip the value.
        if (!box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }

        changed = true;
        changedBoxes.push(c.id);
      }
    }

    if (!changed) return { status: 'SKIPPED', details: 'Already enabled after Edit.' };

    await sleep(500);
    const save = findButton('save');
    if (!save) return { status: 'FAIL', details: 'Changed but Save button not found. Changed: ' + changedBoxes.join(', ') };
    clickReal(save);
    await sleep(1200);

    return { status: 'SUCCESS', details: 'Enabled and saved: ' + changedBoxes.join(', ') };
  })();
}
