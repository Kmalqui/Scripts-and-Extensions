(() => {
  if (window.__appBaBulkAddV2Loaded) {
    window.__appBaBulkAddV2ShowPanel?.();
    return;
  }
  window.__appBaBulkAddV2Loaded = true;

  const CONFIG = {
    editButtonId: 'edit-record-button',
    saveButtonId: 'save-record-button',
    pollMs: 300,
    timeoutMs: 12000,
    afterSaveMs: 1600,
    collectNextDelayMs: 1200,
    maxPages: 300,
    person: {
      first: 'Replacement',
      last: 'User',
      email: 'REPLACEMENT_EMAIL'
    },
    replaceTarget: {
      first: 'Previous',
      last: 'User',
      email: 'PREVIOUS_EMAIL'
    },
    slots: [
      { label: 'Contact Slot 1', first: 'contact-slot-1-first-name', last: 'contact-slot-1-last-name', email: 'contact-slot-1-email' },
      { label: 'Contact Slot 2', first: 'contact-slot-2-first-name', last: 'contact-slot-2-last-name', email: 'contact-slot-2-email' },
      { label: 'Contact Slot 3', first: 'contact-slot-3-first-name', last: 'contact-slot-3-last-name', email: 'contact-slot-3-email' }
    ]
  };

  const PREFIX = '[app Bulk BA Replace/Add]';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = payload => new Promise(resolve => chrome.runtime.sendMessage(payload, resolve));
  const $ = sel => document.querySelector(sel);
  const get = id => document.getElementById(id);
  const norm = s => (s || '').toString().trim().toLowerCase();
  const val = el => (el && typeof el.value === 'string' ? el.value.trim() : '');
  const abs = href => { try { return new URL(href, location.href).href; } catch { return ''; } };
  const log = (...a) => { console.log(PREFIX, ...a); addPanelLog(a.join(' ')); };
  const warn = (...a) => { console.warn(PREFIX, ...a); addPanelLog('WARN: ' + a.join(' ')); };

  let panel, statusEl, logEl, stateCache;

  function addPanelLog(text) {
    if (!logEl) return;
    const div = document.createElement('div');
    div.textContent = `${new Date().toLocaleTimeString()} - ${text}`;
    logEl.prepend(div);
    while (logEl.children.length > 80) logEl.lastChild.remove();
  }

  function makeButton(text, fn, primary=false) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = `margin:4px 4px 0 0;padding:6px 8px;border:1px solid #777;border-radius:4px;cursor:pointer;background:${primary ? '#0b57d0' : '#f4f4f4'};color:${primary ? '#fff' : '#111'};font-size:12px;`;
    b.addEventListener('click', fn);
    return b;
  }

  function showPanel() {
    if (panel) { panel.style.display = 'block'; refreshPanel(); return; }
    panel = document.createElement('div');
    panel.id = 'app-ba-bulk-panel';
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;width:380px;max-height:520px;z-index:2147483647;background:#fff;color:#111;border:2px solid #333;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);font-family:Arial,sans-serif;font-size:12px;padding:12px;';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
        <strong style="font-size:14px;">app Bulk BA Replace/Add</strong>
        <button id="app-ba-close" style="border:0;background:#eee;border-radius:3px;padding:3px 7px;cursor:pointer;">x</button>
      </div>
      <div id="app-ba-status" style="padding:8px;background:#f7f7f7;border:1px solid #ddd;border-radius:4px;margin-bottom:8px;line-height:1.35;"></div>
      <div id="app-ba-buttons"></div>
      <div style="margin-top:8px;font-weight:bold;">Log</div>
      <div id="app-ba-log" style="height:190px;overflow:auto;background:#111;color:#ddd;padding:6px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;"></div>
    `;
    document.documentElement.appendChild(panel);
    statusEl = panel.querySelector('#app-ba-status');
    logEl = panel.querySelector('#app-ba-log');
    panel.querySelector('#app-ba-close').onclick = () => panel.style.display = 'none';
    const btns = panel.querySelector('#app-ba-buttons');
    btns.appendChild(makeButton('Start from listing page', () => startCollection(), true));
    btns.appendChild(makeButton('Process current client only', () => processCurrentOnly()));
    btns.appendChild(makeButton('Stop / reset', () => resetRun()));
    btns.appendChild(makeButton('Download log', () => downloadLog()));
    refreshPanel();
  }
  window.__appBaBulkAddV2ShowPanel = showPanel;

  async function refreshPanel() {
    const res = await send({ type: 'GET_STATE' });
    stateCache = res?.state;
    if (!statusEl || !stateCache) return;
    const total = stateCache.urls?.length || 0;
    statusEl.innerHTML = `
      <div><b>Phase:</b> ${stateCache.phase || 'idle'}</div>
      <div><b>Collected clients:</b> ${total}</div>
      <div><b>Processing:</b> ${stateCache.index || 0}/${total}</div>
      <div><b>Add/replace with:</b> Replacement User</div><div><b>Replace if found:</b> Previous User / PREVIOUS_EMAIL</div>
      <div style="margin-top:4px;color:#555;">Start on the listing page after the Clients section is visible.</div>
    `;
  }

  async function resetRun() {
    await send({ type: 'RESET' });
    log('Reset complete.');
    refreshPanel();
  }

  function downloadLog() {
    const state = stateCache || {};
    const rows = state.log || [];
    const header = ['time','status','slot','url','message','added','total'];
    const csv = [header.join(',')].concat(rows.map(r => header.map(h => JSON.stringify(r[h] ?? '')).join(','))).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `app-ba-bulk-log-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function startCollection() {
    log('Starting collection from this page.');
    await send({ type: 'START_COLLECTION', url: location.href });
    await collectAllPages();
  }
  async function processCurrentOnly() {
    await send({ type: 'PROCESS_CURRENT_ONLY', url: location.href });
    await processClientPage(true);
  }

  function hrefFromOnclick(el) {
    const raw = el.getAttribute('onclick') || '';
    if (!raw) return '';
    const m = raw.match(/(?:location\.href|window\.location|document\.location)\s*=\s*['"]([^'"]+)['"]/i) ||
              raw.match(/(?:open|show|view|edit)[A-Za-z]*Client[A-Za-z]*\s*\(\s*['"]?([^'"),\s]+)['"]?/i) ||
              raw.match(/(Client[^'"\s)]+(?:id|ID|Id)=[^'"\s)]+)/i);
    if (!m) return '';
    const picked = m[1];
    if (/^https?:|^\//i.test(picked)) return abs(picked);
    if (/client/i.test(picked)) return abs(picked);
    return '';
  }

  function looksLikeClientUrl(url, text='') {
    const u = norm(url), t = norm(text);
    if (!u || /javascript:|mailto:|tel:/.test(u)) return false;
    if (/organization|orgprofile|org_profile/.test(u) && !/(recordId|record_id|client=|RecordEditor|record-details)/.test(u)) return false;
    return (
      /(RecordEditor|record-details|record_details|recorddetails|recorddetail|client\/|recordId=|record_id=|client=)/i.test(url) ||
      (/client/i.test(url) && /(profile|card|detail|view|edit|id=)/i.test(url)) ||
      (/client/i.test(t) && /(id=|recordId|record_id|client=)/i.test(url))
    );
  }

  function collectClientLinks() {
    const found = new Set();
    const add = u => { if (u && looksLikeClientUrl(u)) found.add(u); };
    document.querySelectorAll('a[href]').forEach(a => add(abs(a.getAttribute('href'))));
    document.querySelectorAll('[onclick]').forEach(el => add(hrefFromOnclick(el)));

    // Common old app pattern: row links in data attributes
    document.querySelectorAll('[data-url],[data-href],[data-client-id],[recordId]').forEach(el => {
      ['data-url','data-href'].forEach(attr => add(abs(el.getAttribute(attr))));
      const id = el.getAttribute('data-client-id') || el.getAttribute('recordId');
      if (id && /^\d+$/.test(id)) {
        // This is only a fallback; it may or may not match app routing, so keep normal links preferred.
        add(abs(`/record-details.php?record_id=${id}`));
      }
    });
    return [...found];
  }

  function pageSignature() {
    const active = norm($('.active, .selected, [aria-current="page"]')?.textContent || '');
    return `${location.href}::${active}::${collectClientLinks().join('|')}::${document.body.innerText.length}`;
  }
  function disabled(el) {
    const t = norm(`${el.disabled || ''} ${el.getAttribute('aria-disabled') || ''} ${el.className || ''}`);
    return /true|disabled|inactive/.test(t);
  }
  function findNext() {
    const els = [...document.querySelectorAll('a,button,input[type="button"],input[type="submit"]')];
    return els.find(el => {
      if (disabled(el)) return false;
      const txt = norm(el.textContent || el.value || el.title || el.getAttribute('aria-label') || '');
      const cls = norm(`${el.id || ''} ${el.className || ''} ${el.getAttribute('rel') || ''}`);
      return cls.includes('next') || txt === 'next' || txt === '>' || txt === '›' || txt === '»' || txt.includes('next page');
    });
  }
  async function waitForChange(oldSig) {
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      if (pageSignature() !== oldSig) return true;
    }
    return false;
  }
  async function collectAllPages() {
    let page = 0;
    while (page < CONFIG.maxPages) {
      await sleep(600);
      const urls = collectClientLinks();
      log(`This page exposed ${urls.length} possible client link(s).`);
      await send({ type: 'ADD_COLLECTED_URLS', url: location.href, urls });
      refreshPanel();

      const next = findNext();
      if (!next) {
        log('No enabled Next button found. Starting processing.');
        await send({ type: 'START_PROCESSING' });
        return;
      }
      const oldSig = pageSignature();
      log('Clicking Next to scan another record page.');
      next.click();
      page++;
      const changed = await waitForChange(oldSig);
      if (!changed) {
        warn('Next did not change the list. Starting processing with collected links.');
        await send({ type: 'START_PROCESSING' });
        return;
      }
    }
    warn('Max pages reached. Starting processing with collected links.');
    await send({ type: 'START_PROCESSING' });
  }

  function setValue(el, value) {
    if (!el) return;
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }
  function click(id, label) {
    const el = get(id);
    if (!el) return false;
    if (typeof el.onclick === 'function') el.onclick(); else el.click();
    log(`Clicked ${label}.`);
    return true;
  }
  function slotEls() {
    return CONFIG.slots.map(s => ({ ...s, els: { first: get(s.first), last: get(s.last), email: get(s.email) } }));
  }
  function slotPresent(s) { return s.els.first && s.els.last && s.els.email; }
  function slotEmpty(s) { return slotPresent(s) && !val(s.els.first) && !val(s.els.last) && !val(s.els.email); }
  function slotMatchesReplaceTarget(s) {
    if (!slotPresent(s)) return false;
    const first = norm(val(s.els.first));
    const last = norm(val(s.els.last));
    const email = norm(val(s.els.email));
    const target = CONFIG.replaceTarget;
    return email === norm(target.email) || (first === norm(target.first) && last === norm(target.last));
  }
  function fillSlot(s) {
    setValue(s.els.first, CONFIG.person.first);
    setValue(s.els.last, CONFIG.person.last);
    setValue(s.els.email, CONFIG.person.email);
  }
  async function waitForAnySlots() {
    const start = Date.now();
    while (Date.now() - start < CONFIG.timeoutMs) {
      const slots = slotEls();
      if (slots.some(slotPresent)) return slots;
      await sleep(CONFIG.pollMs);
    }
    return null;
  }
  async function processClientPage(single=false) {
    let status = 'skipped', slot = '', message = '';
    try {
      if (!click(CONFIG.editButtonId, 'Edit')) throw new Error('Edit button not found. This may not be a record details page.');
      const slots = await waitForAnySlots();
      if (!slots) throw new Error('Timed out waiting for Contact Slot fields.');
      const targetSlot = slots.find(slotMatchesReplaceTarget);
      if (targetSlot) {
        fillSlot(targetSlot);
        slot = targetSlot.label;
        status = 'updated';
        message = `Replaced Previous User with ${CONFIG.person.first} ${CONFIG.person.last} in ${slot}.`;
        log(message);
        if (!click(CONFIG.saveButtonId, 'Save')) throw new Error('Save button not found after update.');
        await sleep(CONFIG.afterSaveMs);
      } else {
        const empty = slots.find(slotEmpty);
        if (!empty) {
          message = 'Previous User not found and no fully empty Contact Slot slot found. Nothing overwritten.';
          status = 'skipped';
          warn(message);
        } else {
          fillSlot(empty);
          slot = empty.label;
          status = 'updated';
          message = `Added ${CONFIG.person.first} ${CONFIG.person.last} to ${slot}.`;
          log(message);
          if (!click(CONFIG.saveButtonId, 'Save')) throw new Error('Save button not found after update.');
          await sleep(CONFIG.afterSaveMs);
        }
      }
    } catch (e) {
      status = 'error';
      message = e?.message || String(e);
      warn(message);
    }
    await send({ type: single ? 'SINGLE_RESULT' : 'CLIENT_RESULT', url: location.href, status, slot, message });
  }

  (async () => {
    showPanel();
    const res = await send({ type: 'GET_STATE' });
    const state = res?.state;
    if (!state?.active) return;
    if (state.tabId && state.phase === 'collect') {
      // User already pressed Start and this content got reinjected on the same page.
      // Avoid auto-start duplicate collection unless the panel button started it directly.
      return;
    }
    if (state.phase === 'process') await processClientPage(false);
    if (state.phase === 'single') await processClientPage(true);
    if (state.phase === 'done') refreshPanel();
  })();
})();
