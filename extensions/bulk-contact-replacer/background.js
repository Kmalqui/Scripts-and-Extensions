const WAIT_MS = 2200;
const POST_SAVE_WAIT_MS = 3200;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_PROCESS') {
    startProcess(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        await setState({ running: false, lastMessage: `Error: ${err.message}` });
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }
  if (message.type === 'COLLECT_LINKS_ONLY') {
    collectLinksOnly(message.tabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function setState(patch) {
  const data = await chrome.storage.local.get(['runState']);
  const current = data.runState || { running: false, currentIndex: 0, total: 0, lastMessage: 'Ready.' };
  await chrome.storage.local.set({ runState: { ...current, ...patch } });
}

async function appendLog(entry) {
  const data = await chrome.storage.local.get(['logs']);
  const logs = data.logs || [];
  logs.push(entry);
  await chrome.storage.local.set({ logs });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function execute(tabId, func, args = [], options = {}) {
  const inject = {
    target: { tabId },
    func,
    args
  };
  if (options.world) {
    inject.world = options.world;
  }
  const [result] = await chrome.scripting.executeScript(inject);
  return result?.result;
}

async function collectLinksOnly(tabId) {
  const entries = await execute(tabId, collectAllClientLinks, [], { world: 'MAIN' });
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('No record links found on this page.');
  }
  const text = entries.map((e) => `${e.name}: ${e.url}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `client-links-${Date.now()}.txt`,
      saveAs: true
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return { count: entries.length };
}

async function startProcess(tabId) {
  await chrome.storage.local.set({ logs: [] });
  await setState({ running: true, currentIndex: 0, total: 0, lastMessage: 'Collecting record links...' });

  const entries = await execute(tabId, collectAllClientLinks, [], { world: 'MAIN' });
  const links = Array.isArray(entries) ? entries.map((e) => e.url) : [];
  if (!links.length) {
    throw new Error('No record links found on this page.');
  }

  await chrome.storage.local.set({ links });
  await setState({ total: links.length, lastMessage: `Found ${links.length} record links.` });

  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    await setState({ currentIndex: i + 1, total: links.length, lastMessage: `Opening ${i + 1} of ${links.length}` });
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId);
    await sleep(WAIT_MS);

    let result;
    try {
      result = await execute(tabId, updateClientPage, [{
        oldName: 'previous',
        oldLastName: 'user',
        oldEmail: 'PREVIOUS_EMAIL',
        newFirst: 'Replacement',
        newLast: 'User',
        newEmail: 'REPLACEMENT_EMAIL'
      }]);
    } catch (err) {
      result = {
        recordId: extractrecordId(url),
        url,
        status: 'FAIL',
        reason: `Script execution failed: ${err.message}`
      };
    }

    if (result && result.needsPostSaveWait) {
      await sleep(POST_SAVE_WAIT_MS);
      const verify = await execute(tabId, verifyUpdatedFields, [{ newEmail: 'REPLACEMENT_EMAIL' }]);
      if (!verify.ok && result.status === 'SUCCESS') {
        result.status = 'FAIL';
        result.reason = 'Save verification failed';
      }
    }

    await appendLog(result || {
      recordId: extractrecordId(url),
      url,
      status: 'FAIL',
      reason: 'Unknown result'
    });
    await setState({ lastMessage: `${result?.status || 'FAIL'} on client ${result?.recordId || extractrecordId(url)}` });
  }

  await setState({ running: false, lastMessage: 'Run complete.' });
}

function extractrecordId(url) {
  const match = url.match(/\/clients\/(\d+)\/show-record/i);
  return match ? match[1] : 'unknown';
}

async function collectAllClientLinks() {
  const PAGE_SIZE = '150';
  const RESULTS_CONTAINER_SELECTOR = '#resultsContainer';
  const PAGINATION_SELECTOR = '#pagination';
  const PAGE_SIZE_SELECTOR = '#pageSize';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function waitFor(selector, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${selector}`);
  }

  function getContainerSignature(container) {
    if (!container) return '';
    return (container.innerText || '').slice(0, 2000);
  }

  async function waitForRefresh(container, previousSignature, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const currentSignature = getContainerSignature(container);
      if (currentSignature !== previousSignature) return true;
      await sleep(150);
    }
    return false;
  }

  function getClientLinksFromContainer(container) {
    const anchors = Array.from(
      container.querySelectorAll("a._popup, a[href*='/records/'][href*='/show-record']")
    );

    return anchors
      .filter((a) => {
        const href = a.getAttribute('href') || '';
        return href.includes('/records/') && href.includes('/show-record') && isVisible(a);
      })
      .map((a) => ({
        name: (a.textContent || '').trim(),
        url: a.href
      }))
      .filter((x) => x.name && x.url);
  }

  function dedupeByUrl(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
  }

  function getTotalPages() {
    const pagination = document.querySelector(PAGINATION_SELECTOR);
    if (!pagination) return 1;

    const pageNums = Array.from(pagination.querySelectorAll('.pageNumbers a, .pageNumbers span'))
      .map((el) => (el.textContent || '').trim())
      .filter((t) => /^\d+$/.test(t))
      .map(Number);

    return pageNums.length ? Math.max(...pageNums) : 1;
  }

  async function setPageSizeIfNeeded() {
    const sel = document.querySelector(PAGE_SIZE_SELECTOR);
    if (!sel) {
      return;
    }

    if (sel.value === PAGE_SIZE) return;

    const container = document.querySelector(RESULTS_CONTAINER_SELECTOR);
    const before = getContainerSignature(container);

    sel.value = PAGE_SIZE;
    sel.dispatchEvent(new Event('change', { bubbles: true }));

    if (container) {
      await waitForRefresh(container, before, 20000);
      await sleep(500);
    }
  }

  async function goToPage(pageNum) {
    const container = document.querySelector(RESULTS_CONTAINER_SELECTOR);
    const before = getContainerSignature(container);

    if (typeof window.loadNextPage === 'function') {
      window.loadNextPage(
        'getRecordsPage',
        'resultsContainer',
        { objClass: 'RecordCollection', pageSize: Number(PAGE_SIZE), load: 1, sort: 'asc' },
        pageNum
      );
    } else {
      const pagination = document.querySelector(PAGINATION_SELECTOR);
      if (!pagination) throw new Error('Pagination not found.');

      const pageLink = Array.from(pagination.querySelectorAll('.pageNumbers a')).find(
        (a) => (a.textContent || '').trim() === String(pageNum)
      );

      if (!pageLink) throw new Error(`Could not find page link for page ${pageNum}`);
      pageLink.click();
    }

    if (container) {
      const changed = await waitForRefresh(container, before, 20000);
      if (!changed) {
        console.warn(`Page ${pageNum}: content may not have changed before timeout.`);
      }
    }

    await sleep(500);
  }

  await waitFor(RESULTS_CONTAINER_SELECTOR, 15000);
  await setPageSizeIfNeeded();

  const container = document.querySelector(RESULTS_CONTAINER_SELECTOR);
  if (!container) throw new Error('Could not find results container.');

  let totalPages = getTotalPages();
  if (!totalPages || totalPages < 1) totalPages = 1;

  const allLinks = [];

  for (let page = 1; page <= totalPages; page++) {
    if (page > 1) {
      await goToPage(page);
    }

    const pageLinks = getClientLinksFromContainer(container);
    allLinks.push(...pageLinks);
  }

  return dedupeByUrl(allLinks);
}

function updateClientPage(config) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  return (async () => {
    const recordId = (location.pathname.match(/\/clients\/(\d+)\/show-record/i) || [])[1] || 'unknown';
    const result = { recordId, url: location.href, status: 'FAIL', reason: '', needsPostSaveWait: false };

    const groups = [
      {
        label: 'BA1',
        first: document.getElementById('contact-slot-1-first-name'),
        last: document.getElementById('contact-slot-1-last-name'),
        email: document.getElementById('contact-slot-1-email')
      },
      {
        label: 'BA2',
        first: document.getElementById('contact-slot-2-first-name'),
        last: document.getElementById('contact-slot-2-last-name'),
        email: document.getElementById('contact-slot-2-email')
      },
      {
        label: 'BA3',
        first: document.getElementById('contact-slot-3-first-name') || document.getElementById('contact-slot-3-first-name'),
        last: document.getElementById('contact-slot-3-last-name') || document.getElementById('contact-slot-3-last-name'),
        email: document.getElementById('contact-slot-3-email') || document.getElementById('contact-slot-3-email')
      }
    ];

    const editableGroups = groups.filter(g => g.first && g.last && g.email);
    if (!editableGroups.length) {
      result.reason = 'No BA fields found';
      return result;
    }

    const hasOld = editableGroups.some(g => {
      const first = (g.first.value || '').trim().toLowerCase();
      const last = (g.last.value || '').trim().toLowerCase();
      const email = (g.email.value || '').trim().toLowerCase();
      return email === config.oldEmail || (first === config.oldName && last === config.oldLastName);
    });

    const alreadyUpdated = editableGroups.some(g => ((g.email.value || '').trim().toLowerCase() === config.newEmail.toLowerCase()));

    if (!hasOld && alreadyUpdated) {
      result.status = 'SKIPPED';
      result.reason = 'Already updated';
      return result;
    }

    if (!hasOld) {
      result.status = 'SKIPPED';
      result.reason = 'Target person not found';
      return result;
    }

    const editBtn = document.getElementById('edit-record-button');
    if (!editBtn) {
      result.reason = 'Edit button not found';
      return result;
    }

    editBtn.click();
    await wait(1500);

    const editGroups = [
      {
        label: 'BA1',
        first: document.getElementById('contact-slot-1-first-name'),
        last: document.getElementById('contact-slot-1-last-name'),
        email: document.getElementById('contact-slot-1-email')
      },
      {
        label: 'BA2',
        first: document.getElementById('contact-slot-2-first-name'),
        last: document.getElementById('contact-slot-2-last-name'),
        email: document.getElementById('contact-slot-2-email')
      },
      {
        label: 'BA3',
        first: document.getElementById('contact-slot-3-first-name') || document.getElementById('contact-slot-3-first-name'),
        last: document.getElementById('contact-slot-3-last-name') || document.getElementById('contact-slot-3-last-name'),
        email: document.getElementById('contact-slot-3-email') || document.getElementById('contact-slot-3-email')
      }
    ].filter(g => g.first && g.last && g.email);

    let updatedLabels = [];
    for (const g of editGroups) {
      const first = (g.first.value || '').trim().toLowerCase();
      const last = (g.last.value || '').trim().toLowerCase();
      const email = (g.email.value || '').trim().toLowerCase();
      if (email === config.oldEmail || (first === config.oldName && last === config.oldLastName)) {
        g.first.value = config.newFirst;
        g.last.value = config.newLast;
        g.email.value = config.newEmail;
        g.first.dispatchEvent(new Event('input', { bubbles: true }));
        g.last.dispatchEvent(new Event('input', { bubbles: true }));
        g.email.dispatchEvent(new Event('input', { bubbles: true }));
        g.first.dispatchEvent(new Event('change', { bubbles: true }));
        g.last.dispatchEvent(new Event('change', { bubbles: true }));
        g.email.dispatchEvent(new Event('change', { bubbles: true }));
        updatedLabels.push(g.label);
      }
    }

    if (!updatedLabels.length) {
      result.status = 'SKIPPED';
      result.reason = 'Target person not found after edit opened';
      return result;
    }

    const saveBtn = document.getElementById('save-record-button');
    if (!saveBtn) {
      result.reason = 'Save button not found';
      return result;
    }

    saveBtn.click();
    result.status = 'SUCCESS';
    result.reason = `Updated ${updatedLabels.join(', ')}`;
    result.needsPostSaveWait = true;
    return result;
  })();
}

function verifyUpdatedFields(config) {
  const groups = [
    document.getElementById('contact-slot-1-email'),
    document.getElementById('contact-slot-2-email'),
    document.getElementById('contact-slot-3-email') || document.getElementById('contact-slot-3-email')
  ].filter(Boolean);
  const ok = groups.some(el => (el.value || '').trim().toLowerCase() === config.newEmail.toLowerCase());
  return { ok };
}
