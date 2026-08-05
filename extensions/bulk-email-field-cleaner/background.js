const TARGET_EMAIL = 'TARGET_EMAIL';
const RESULTS_CONTAINER_SELECTOR = '#resultsContainer';
const PAGINATION_SELECTOR = '#pagination';
const PAGE_SIZE_SELECTOR = '#pageSize';
const PAGE_SIZE = '150';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function setState(patch) {
  const current = (await chrome.storage.local.get('state')).state || {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ state: next });
}

async function addLog(entry) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.push(entry);
  await chrome.storage.local.set({ logs });
}

async function resetRun() {
  await chrome.storage.local.set({ logs: [], state: { phase: 'idle', message: 'Ready.' } });
}

chrome.runtime.onInstalled.addListener(() => {
  resetRun().catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'START') {
    runWorkflow(msg.tabId).catch(async (err) => {
      console.error(err);
      await setState({ phase: 'error', message: err.message || String(err) });
    });
    sendResponse({ ok: true });
    return true;
  }
});

async function execInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return result?.result;
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(250);
  }

  throw new Error('Timed out waiting for page load.');
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
  await sleep(500);
}

async function runWorkflow(tabId) {
  await resetRun();
  await setState({ phase: 'collecting', message: 'Collecting record links across all pages...' });

  const links = await collectAllClientLinks(tabId);
  if (!links.length) {
    throw new Error('No record links found on this page.');
  }

  await chrome.storage.local.set({ collectedLinks: links });
  await setState({ phase: 'processing', message: `Collected ${links.length} client link(s). Starting updates...`, total: links.length, currentIndex: 0 });

  for (let i = 0; i < links.length; i++) {
    const item = links[i];
    await setState({ phase: 'processing', message: `Processing ${item.name || item.url}`, currentIndex: i + 1, total: links.length });

    try {
      await navigateTab(tabId, item.url);
      const result = await execInTab(tabId, processClientPage, [TARGET_EMAIL]);
      await addLog({
        clientName: item.name || '',
        clientUrl: item.url,
        recordId: result?.recordId || extractrecordId(item.url),
        status: result?.status || 'FAIL',
        reason: result?.reason || '',
        changedFields: result?.changedFields || [],
        removedCount: result?.removedCount || 0,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      await addLog({
        clientName: item.name || '',
        clientUrl: item.url,
        recordId: extractrecordId(item.url),
        status: 'FAIL',
        reason: err.message || String(err),
        changedFields: [],
        removedCount: 0,
        timestamp: new Date().toISOString()
      });
    }
  }

  await setState({ phase: 'done', message: `Finished ${links.length} record page(s).` });
}

function extractrecordId(url) {
  const m = String(url).match(/\/clients\/(\d+)\//);
  return m ? m[1] : '';
}

async function collectAllClientLinks(tabId) {
  return await execInTab(tabId, async ({ RESULTS_CONTAINER_SELECTOR, PAGINATION_SELECTOR, PAGE_SIZE_SELECTOR, PAGE_SIZE }) => {
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
      const anchors = Array.from(container.querySelectorAll("a._popup, a[href*='/records/'][href*='/show-record']"));
      return anchors
        .filter(a => {
          const href = a.getAttribute('href') || '';
          return href.includes('/records/') && href.includes('/show-record') && isVisible(a);
        })
        .map(a => ({ name: (a.textContent || '').trim(), url: a.href }))
        .filter(x => x.url);
    }

    function dedupeByUrl(items) {
      const seen = new Set();
      return items.filter(item => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
    }

    function getTotalPages() {
      const pagination = document.querySelector(PAGINATION_SELECTOR);
      if (!pagination) return 1;
      const pageNums = Array.from(pagination.querySelectorAll('.pageNumbers a, .pageNumbers span'))
        .map(el => (el.textContent || '').trim())
        .filter(t => /^\d+$/.test(t))
        .map(Number);
      return pageNums.length ? Math.max(...pageNums) : 1;
    }

    async function setPageSizeIfNeeded() {
      const sel = document.querySelector(PAGE_SIZE_SELECTOR);
      if (!sel) return;
      if (String(sel.value) === String(PAGE_SIZE)) return;
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
        const pageLink = Array.from(pagination.querySelectorAll('.pageNumbers a')).find(a => (a.textContent || '').trim() === String(pageNum));
        if (!pageLink) throw new Error(`Could not find page link for page ${pageNum}`);
        pageLink.click();
      }

      if (container) {
        await waitForRefresh(container, before, 20000);
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
  }, [{ RESULTS_CONTAINER_SELECTOR, PAGINATION_SELECTOR, PAGE_SIZE_SELECTOR, PAGE_SIZE }]);
}

function processClientPage(targetEmail) {
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function normalizeList(rawValue) {
    const parts = String(rawValue || '')
      .split(/[;,\n]+/)
      .map(x => x.trim())
      .filter(Boolean);

    const seen = new Set();
    const cleaned = [];
    for (const part of parts) {
      const key = part.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        cleaned.push(part);
      }
    }
    return cleaned.join('; ');
  }

  function removeTargetFromValue(value, target) {
    const lowerTarget = target.toLowerCase();
    const parts = String(value || '')
      .split(/[;,\n]+/)
      .map(x => x.trim())
      .filter(Boolean);
    const kept = parts.filter(part => part.toLowerCase() !== lowerTarget);
    return normalizeList(kept.join('; '));
  }

  function getFieldLabel(el) {
    return el.id || el.name || el.placeholder || 'unknown-field';
  }

  async function run() {
    const recordId = (location.pathname.match(/\/clients\/(\d+)\//) || [])[1] || '';
    const editBtn = document.getElementById('edit-record-button');
    if (!editBtn) {
      return { recordId, status: 'FAIL', reason: 'Edit button not found', changedFields: [], removedCount: 0 };
    }

    editBtn.click();
    await sleep(1200);

    const fields = Array.from(document.querySelectorAll('input[type="text"], input[type="email"], textarea'));
    const changedFields = [];
    let removedCount = 0;

    for (const field of fields) {
      const current = String(field.value || '');
      if (!current || !current.toLowerCase().includes(targetEmail.toLowerCase())) continue;
      const updated = removeTargetFromValue(current, targetEmail);
      if (updated === current) continue;

      field.focus();
      field.value = updated;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      changedFields.push(getFieldLabel(field));
      removedCount += 1;
    }

    if (!removedCount) {
      return { recordId, status: 'SKIPPED', reason: 'Target email not found', changedFields: [], removedCount: 0 };
    }

    const saveBtn = document.getElementById('save-record-button');
    if (!saveBtn) {
      return { recordId, status: 'FAIL', reason: 'Save button not found', changedFields, removedCount };
    }

    saveBtn.click();
    await sleep(2200);

    const remaining = Array.from(document.querySelectorAll('input[type="text"], input[type="email"], textarea'))
      .filter(field => String(field.value || '').toLowerCase().includes(targetEmail.toLowerCase()));

    if (remaining.length) {
      return {
        recordId,
        status: 'FAIL',
        reason: 'Save verification failed. Target email still present.',
        changedFields,
        removedCount,
      };
    }

    return { recordId, status: 'SUCCESS', reason: '', changedFields, removedCount };
  }

  return run();
}
