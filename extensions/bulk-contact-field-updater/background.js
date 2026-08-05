const STATE_KEY = 'appBaBulkAddStateV2';
const CONTENT_FILE = 'content.js';

function emptyState() {
  return {
    active: false,
    tabId: null,
    urls: [],
    seen: {},
    index: 0,
    phase: 'idle',
    log: [],
    startedAt: null,
    returnUrl: null
  };
}

async function getState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || emptyState();
}
async function setState(state) { await chrome.storage.local.set({ [STATE_KEY]: state }); }
async function resetState() {
  await chrome.storage.local.set({ [STATE_KEY]: emptyState() });
  try { await chrome.action.setBadgeText({ text: '' }); } catch {}
}
function addLog(state, row) {
  state.log.push({ time: new Date().toISOString(), ...row });
  if (state.log.length > 1500) state.log.shift();
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] }); }
  catch (e) { console.warn('[app BA Bulk Add] inject failed:', e?.message || e); }
}
async function badge(tabId, text, color = '#555') {
  try {
    await chrome.action.setBadgeText({ text, tabId });
    await chrome.action.setBadgeBackgroundColor({ color, tabId });
  } catch {}
}
async function goNext(tabId) {
  const state = await getState();
  if (!state.active || state.phase !== 'process' || state.tabId !== tabId) return;
  if (state.index >= state.urls.length) {
    addLog(state, { status: 'complete', message: `Finished ${state.urls.length} clients.` });
    state.phase = 'done';
    await setState(state);
    await badge(tabId, 'Done', '#078a07');
    await inject(tabId);
    return;
  }
  await badge(tabId, `${state.index + 1}/${state.urls.length}`, '#555');
  await chrome.tabs.update(tabId, { url: state.urls[state.index] });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await inject(tab.id);
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const state = await getState();
  if (state.active && state.tabId === tabId) await inject(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab?.id;
    let state = await getState();

    if (msg.type === 'GET_STATE') return sendResponse({ ok: true, state });

    if (msg.type === 'RESET') {
      await resetState();
      return sendResponse({ ok: true, state: emptyState() });
    }

    if (msg.type === 'START_COLLECTION') {
      state = emptyState();
      state.active = true;
      state.tabId = tabId;
      state.phase = 'collect';
      state.startedAt = new Date().toISOString();
      state.returnUrl = msg.url || null;
      addLog(state, { status: 'start', url: msg.url, message: 'Started client collection from listing page.' });
      await setState(state);
      await badge(tabId, 'Scan', '#8a6d07');
      await inject(tabId);
      return sendResponse({ ok: true, state });
    }

    if (msg.type === 'ADD_COLLECTED_URLS') {
      if (!state.active || state.tabId !== tabId) return sendResponse({ ok: false, error: 'No active run for this tab.' });
      let added = 0;
      (msg.urls || []).forEach(url => {
        if (!url || state.seen[url]) return;
        state.seen[url] = true;
        state.urls.push(url);
        added++;
      });
      addLog(state, { status: 'collect', url: msg.url, added, total: state.urls.length, message: `Collected ${added}; total ${state.urls.length}.` });
      await setState(state);
      await badge(tabId, String(state.urls.length), '#8a6d07');
      return sendResponse({ ok: true, added, total: state.urls.length });
    }

    if (msg.type === 'START_PROCESSING') {
      if (!state.active || state.tabId !== tabId) return sendResponse({ ok: false, error: 'No active run for this tab.' });
      state.phase = 'process';
      state.index = 0;
      addLog(state, { status: 'process_start', total: state.urls.length, message: `Processing ${state.urls.length} record pages.` });
      await setState(state);
      sendResponse({ ok: true, total: state.urls.length });
      setTimeout(() => goNext(tabId), 250);
      return;
    }

    if (msg.type === 'CLIENT_RESULT') {
      if (!state.active || state.tabId !== tabId) return sendResponse({ ok: false, error: 'No active run for this tab.' });
      addLog(state, {
        status: msg.status,
        url: msg.url,
        slot: msg.slot || '',
        message: msg.message || ''
      });
      state.index++;
      await setState(state);
      sendResponse({ ok: true, next: state.index, total: state.urls.length });
      setTimeout(() => goNext(tabId), 800);
      return;
    }

    if (msg.type === 'PROCESS_CURRENT_ONLY') {
      state = emptyState();
      state.active = true;
      state.tabId = tabId;
      state.phase = 'single';
      state.urls = [msg.url];
      state.startedAt = new Date().toISOString();
      addLog(state, { status: 'single_start', url: msg.url, message: 'Processing current page only.' });
      await setState(state);
      await badge(tabId, '1/1', '#555');
      await inject(tabId);
      return sendResponse({ ok: true });
    }

    if (msg.type === 'SINGLE_RESULT') {
      addLog(state, { status: msg.status, url: msg.url, slot: msg.slot || '', message: msg.message || '' });
      state.phase = 'done';
      await setState(state);
      await badge(tabId, 'Done', '#078a07');
      return sendResponse({ ok: true });
    }

    sendResponse({ ok: false, error: 'Unknown message.' });
  })();
  return true;
});
