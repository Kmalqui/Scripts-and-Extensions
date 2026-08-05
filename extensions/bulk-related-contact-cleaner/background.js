const WAIT_MS = 2500;
const POST_SAVE_WAIT_MS = 4500;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_PROCESS') {
    startProcess(message.tabId, message.emailToRemove)
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        await setState({ running: false, lastMessage: `Error: ${err.message}` });
        sendResponse({ ok: false, error: err.message });
      });
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
  logs.push({ timestamp: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ logs });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeout = 45000) {
  return new Promise(async (resolve, reject) => {
    try {
      const existing = await chrome.tabs.get(tabId);
      if (existing.status === 'complete') return resolve();
    } catch (e) {}

    const start = Date.now();
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    const timer = setInterval(() => {
      if (Date.now() - start > timeout) {
        cleanup();
        reject(new Error('Timed out waiting for tab to load.'));
      }
    }, 500);
    function cleanup() {
      clearInterval(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function execute(tabId, func, args = [], world = 'MAIN') {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func,
    args
  });
  return result?.result;
}

async function startProcess(tabId, emailToRemove) {
  await chrome.storage.local.set({ logs: [] });
  await setState({ running: true, currentIndex: 0, total: 0, lastMessage: 'Collecting record links...' });

  // Collection does not need page functions, but MAIN is fine and keeps behavior consistent.
  const links = await execute(tabId, collectClientLinks, [], 'MAIN');
  if (!Array.isArray(links) || !links.length) {
    throw new Error('No record links found on this page. Start from an listing/search/client-list page that contains /records/{id}/show-record links.');
  }

  await chrome.storage.local.set({ links });
  await setState({ total: links.length, lastMessage: `Found ${links.length} record links.` });

  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    const recordId = extractrecordId(url);
    await setState({ currentIndex: i + 1, total: links.length, lastMessage: `Opening ${i + 1} of ${links.length}: client ${recordId}` });

    let result;
    try {
      await chrome.tabs.update(tabId, { url });
      await waitForTabComplete(tabId);
      await sleep(WAIT_MS);

      result = await execute(tabId, removeAssistantAndDisableSetting, [{ emailToRemove }], 'MAIN');
    } catch (err) {
      result = {
        recordId,
        url,
        status: 'FAIL',
        reason: `Script execution failed: ${err.message}`
      };
    }

    if (result && result.needsPostSaveWait) {
      await sleep(POST_SAVE_WAIT_MS);
      try {
        const verify = await execute(tabId, verifyAssistantRemoved, [{ emailToRemove }], 'MAIN');
        result.verify = verify;
        if (!verify.ok && result.status === 'SUCCESS') {
          result.status = 'FAIL';
          result.reason = `Save verification failed: ${verify.reason}`;
        }
      } catch (err) {
        result.status = 'FAIL';
        result.reason = `Verification script failed: ${err.message}`;
      }
    }

    await appendLog(result || {
      recordId,
      url,
      status: 'FAIL',
      reason: 'Unknown result'
    });
    await setState({ lastMessage: `${result?.status || 'FAIL'} on client ${result?.recordId || recordId}: ${result?.reason || ''}` });
    await sleep(800);
  }

  await setState({ running: false, lastMessage: 'Run complete.' });
}

function extractrecordId(url) {
  const match = url.match(/\/clients\/(\d+)\/show-record/i);
  return match ? match[1] : 'unknown';
}

function collectClientLinks() {
  const anchors = Array.from(document.querySelectorAll('a[href*="/records/"][href*="/show-record"]'));
  const links = anchors
    .map(a => a.href || a.getAttribute('href'))
    .filter(Boolean)
    .map(href => new URL(href, location.origin).href)
    .filter(href => /\/clients\/\d+\/show-record/i.test(href));
  return [...new Set(links)];
}

function removeAssistantAndDisableSetting(config) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function getrecordId() {
    return (location.pathname.match(/\/clients\/(\d+)\/show-record/i) || [])[1] || 'unknown';
  }

  function waitForElement(id, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const el = document.getElementById(id);
        if (el) {
          clearInterval(timer);
          resolve(el);
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          reject(new Error(`Element not found: #${id}`));
        }
      }, 100);
    });
  }

  function setInputValue(el, value) {
    el.value = value;
    // MooTools pages sometimes keep value through Element storage/wrappers. Use it if present.
    if (typeof el.set === 'function') {
      try { el.set('value', value); } catch (e) {}
    }
    el.setAttribute('value', value);
  }

  return (async () => {
    const emailToRemove = (config.emailToRemove || '').trim().toLowerCase();
    const result = {
      recordId: getrecordId(),
      url: location.href,
      status: 'FAIL',
      reason: '',
      needsPostSaveWait: false,
      before: {},
      after: {}
    };

    if (!emailToRemove) {
      result.reason = 'No email configured to remove';
      return result;
    }

    // Important: enter edit mode FIRST. Some record pages do not expose #related-contact-email until edit mode.
    if (!window.RecordEditorAPI || typeof window.RecordEditorAPI.edit !== 'function') {
      result.reason = 'RecordEditorAPI.edit() not available. This script must run in the page MAIN world.';
      return result;
    }

    window.RecordEditorAPI.edit();
    await wait(1200);

    let assistantEmail;
    try {
      assistantEmail = await waitForElement('related-contact-email');
    } catch (e) {
      result.status = 'SKIPPED';
      result.reason = 'related-contact-email field not found after edit';
      return result;
    }

    const relatedContactEnabled = document.getElementById('relatedContactEnabled');
    const currentValue = (assistantEmail.value || '').trim();
    const currentValueLower = currentValue.toLowerCase();
    const ccWasChecked = !!(relatedContactEnabled && relatedContactEnabled.checked);

    result.before = {
      assistantEmail: currentValue || '(blank)',
      relatedContactEnabledChecked: ccWasChecked
    };

    let removed = false;
    let disabled = false;

    // IMPORTANT: Only make ANY change when the base related-contact-email exactly matches the target email.
    // If a different assistant is listed, leave both the email and relatedContactEnabled setting untouched.
    if (currentValueLower !== emailToRemove) {
      result.status = 'SKIPPED';
      result.reason = `Skipped untouched because related-contact-email is ${currentValue || '(blank)'}, not ${config.emailToRemove}`;
      result.after = {
        assistantEmail: assistantEmail.value || '(blank)',
        relatedContactEnabledChecked: !!(relatedContactEnabled && relatedContactEnabled.checked)
      };
      return result;
    }

    setInputValue(assistantEmail, '');
    removed = true;

    if (relatedContactEnabled && relatedContactEnabled.checked) {
      relatedContactEnabled.checked = false;
      relatedContactEnabled.removeAttribute('checked');
      if (typeof window.toggleCCrelated-contact-emailsCheckboxes === 'function') {
        window.toggleCCrelated-contact-emailsCheckboxes(relatedContactEnabled);
      }
      disabled = true;
    }

    result.after = {
      assistantEmail: assistantEmail.value || '(blank)',
      relatedContactEnabledChecked: !!(relatedContactEnabled && relatedContactEnabled.checked)
    };

    if (!window.RecordEditorAPI || typeof window.RecordEditorAPI.save !== 'function') {
      result.reason = 'RecordEditorAPI.save() not available';
      return result;
    }

    await wait(500);
    window.RecordEditorAPI.save();

    result.status = 'SUCCESS';
    result.reason = [
      `cleared ${config.emailToRemove}`,
      disabled ? 'unchecked relatedContactEnabled' : 'relatedContactEnabled already unchecked or not found'
    ].join('; ');
    result.needsPostSaveWait = true;
    return result;
  })();
}

function verifyAssistantRemoved(config) {
  const emailToRemove = (config.emailToRemove || '').trim().toLowerCase();
  const recordId = (location.pathname.match(/\/clients\/(\d+)\/show-record/i) || [])[1] || 'unknown';

  const assistantEmail = document.getElementById('related-contact-email');
  const relatedContactEnabled = document.getElementById('relatedContactEnabled');

  // If the page is no longer in edit mode and the input is not visible, use page text as a weaker check.
  const stillVisibleInPageText = (document.body.innerText || '').toLowerCase().includes(emailToRemove);

  if (!assistantEmail) {
    return {
      ok: !stillVisibleInPageText && !(relatedContactEnabled && relatedContactEnabled.checked),
      recordId,
      reason: stillVisibleInPageText ? 'Target email still appears in page text' : 'Input not present after save; target email not found in page text',
      assistantEmailPresent: false,
      relatedContactEnabledChecked: !!(relatedContactEnabled && relatedContactEnabled.checked)
    };
  }

  const stillHasEmail = (assistantEmail.value || '').trim().toLowerCase() === emailToRemove;
  const stillChecked = !!(relatedContactEnabled && relatedContactEnabled.checked);

  return {
    ok: !stillHasEmail && !stillChecked,
    recordId,
    reason: stillHasEmail ? 'related-contact-email still contains target email' : stillChecked ? 'relatedContactEnabled is still checked' : 'Verified',
    assistantEmailValue: assistantEmail.value || '(blank)',
    relatedContactEnabledChecked: stillChecked
  };
}
