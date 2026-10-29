/* EasyView popup: a remote control for content.js. It keeps no settings of its own;
   it asks the page for its state and redraws whatever comes back. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'), controls: $('controls'), comfort: $('comfort'),
    comfortSlider: $('comfort-slider'), comfortValue: $('comfort-value'),
    sizeDown: $('size-down'), sizeUp: $('size-up'), sizeReset: $('size-reset'),
    sizeValue: $('size-value'), sizeSlider: $('size-slider'),
    play: $('read-play'), pause: $('read-pause'), stop: $('read-stop'), readNote: $('read-note'),
    resetAll: $('reset-all'), site: $('site')
  };
  const toggles = Array.from(document.querySelectorAll('[data-setting]'));
  const radios = Array.from(document.querySelectorAll('input[name="theme"]'));

  let tabId = null;
  let tabUrl = '';
  let state = null;

  const isSupportedUrl = (url) => /^(https?|file):/i.test(url);
  const isOn = (btn) => btn.getAttribute('aria-checked') === 'true';

  function setSwitch(btn, on) {
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    const label = btn.querySelector('.toggle-state');
    if (label) label.textContent = on ? 'On' : 'Off';
  }

  function showStatus(text) {
    els.status.textContent = text;
    els.status.hidden = !text;
  }

  function lockControls(locked) {
    els.controls.inert = locked;
    els.controls.setAttribute('aria-disabled', locked ? 'true' : 'false');
  }

  function showUnavailable() {
    lockControls(true);
    if (tabUrl && !isSupportedUrl(tabUrl)) {
      showStatus('EasyView cannot change this kind of page (for example a Chrome page or a new tab). Please open a normal website and try again.');
    } else {
      showStatus('EasyView could not connect to this page. Reload the page and try again. Some pages, such as the Chrome Web Store, are always blocked. For files saved on your computer, turn on "Allow access to file URLs" for EasyView on the extensions page.');
    }
  }

  function setSlider(slider, value) {
    // Never move a slider the person is currently using.
    if (document.activeElement !== slider) slider.value = String(value);
    slider.setAttribute('aria-valuetext', slider.value + ' percent');
  }

  function renderReader() {
    const r = state.reader;
    els.play.disabled = !r.supported || r.state !== 'idle';
    els.pause.disabled = !r.supported || r.state === 'idle';
    els.pause.textContent = r.state === 'paused' ? 'Resume' : 'Pause';
    els.stop.disabled = !r.supported || r.state === 'idle';
    els.readNote.textContent = r.supported
      ? 'Reads your selected text, or the main text of the page.'
      : 'Read Aloud is not supported in this browser.';
  }

  function render(next, notice) {
    state = next;
    const s = state.settings;
    setSwitch(els.comfort, s.comfort);
    toggles.forEach((btn) => setSwitch(btn, s[btn.dataset.setting] === true));
    els.sizeValue.textContent = s.textScale + '%';
    els.sizeDown.disabled = s.textScale <= state.limits.min;
    els.sizeUp.disabled = s.textScale >= state.limits.max;
    setSlider(els.sizeSlider, s.textScale);
    els.comfortValue.textContent = state.comfortScale + '%';
    setSlider(els.comfortSlider, state.comfortScale);
    radios.forEach((radio) => { radio.checked = radio.value === s.theme; });
    try { els.site.textContent = new URL(state.origin).host || state.origin; } catch (e) { els.site.textContent = state.origin; }
    renderReader();
    lockControls(false);
    showStatus(notice || '');
  }

  async function injectContentScript() {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['accessibility.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }

  async function sendToTab(message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (err) {
      // Page was open before EasyView was installed: inject once, then retry.
      await injectContentScript();
      return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    }
  }

  async function request(message) {
    if (tabId == null) { showUnavailable(); return; }
    try {
      const res = await sendToTab(message);
      if (!res || !res.ok) throw new Error((res && res.error) || 'No response from the page');
      render(res.state, res.notice);
    } catch (err) {
      console.warn('EasyView popup:', err);
      showUnavailable();
    }
  }

  // Sends slider values while dragging, but never more than one request at a time.
  function bindSlider(slider, valueEl, buildMessage) {
    let inFlight = false;
    let latest = null;
    const flush = async () => {
      if (inFlight || latest === null) return;
      inFlight = true;
      const value = latest;
      latest = null;
      await request(buildMessage(value));
      inFlight = false;
      if (latest !== null) flush();
    };
    slider.addEventListener('input', () => {
      const value = Number(slider.value);
      valueEl.textContent = value + '%';
      slider.setAttribute('aria-valuetext', value + ' percent');
      latest = value;
      flush();
    });
  }

  function bindEvents() {
    els.comfort.addEventListener('click', () => request({ type: 'EV_COMFORT', enabled: !isOn(els.comfort) }));
    bindSlider(els.comfortSlider, els.comfortValue, (value) => ({ type: 'EV_COMFORT_SCALE', value }));
    bindSlider(els.sizeSlider, els.sizeValue, (value) => ({ type: 'EV_UPDATE', patch: { textScale: value } }));

    toggles.forEach((btn) => {
      btn.addEventListener('click', () => request({ type: 'EV_UPDATE', patch: { [btn.dataset.setting]: !isOn(btn) } }));
    });
    radios.forEach((radio) => {
      radio.addEventListener('change', () => { if (radio.checked) request({ type: 'EV_UPDATE', patch: { theme: radio.value } }); });
    });
    els.sizeDown.addEventListener('click', () => request({ type: 'EV_TEXT_SIZE', action: 'decrease' }));
    els.sizeUp.addEventListener('click', () => request({ type: 'EV_TEXT_SIZE', action: 'increase' }));
    els.sizeReset.addEventListener('click', () => request({ type: 'EV_TEXT_SIZE', action: 'reset' }));
    els.play.addEventListener('click', () => request({ type: 'EV_READ', action: 'play' }));
    els.pause.addEventListener('click', () => {
      const paused = state && state.reader.state === 'paused';
      request({ type: 'EV_READ', action: paused ? 'resume' : 'pause' });
    });
    els.stop.addEventListener('click', () => request({ type: 'EV_READ', action: 'stop' }));
    els.resetAll.addEventListener('click', () => request({ type: 'EV_RESET' }));

    // The page tells us when reading starts, pauses or finishes (also from the on-page bar).
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (!msg || msg.type !== 'EV_READER_CHANGED' || !state) return;
      if (sender.tab && sender.tab.id !== tabId) return;
      state.reader = msg.reader;
      renderReader();
    });
  }

  async function init() {
    bindEvents();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) { tabId = tab.id; tabUrl = tab.url || ''; }
    } catch (err) {
      console.warn('EasyView popup: could not read the active tab', err);
    }
    if (tabId == null || (tabUrl && !isSupportedUrl(tabUrl))) { showUnavailable(); return; }
    await request({ type: 'EV_GET_STATE' });
  }

  init();
})();