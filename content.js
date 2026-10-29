/* EasyView content script.
   Owns the settings, applies them to the page, and answers messages from the popup.
   Settings are saved ONCE and used on every website. Sections:
   1 constants   2 settings   3 apply   4 page observer   5 text size   6 colour tagging
   7 cursor halo 8 focus      9 Read Aloud   10 floating UI   11 messages   12 start-up */
(() => {
  'use strict';

  // Guard: the popup may inject this file again on tabs opened before install.
  if (window.__easyViewLoaded) return;
  window.__easyViewLoaded = true;

  /* ---------- 1. Constants ---------- */
  const STORAGE_KEY = 'easyviewSites';          // saved settings
  const SITE_KEY = 'all-websites';              // one shared entry, so settings follow you from site to site
  const COMFORT_SCALE_KEY = 'easyviewComfortScale'; // the Comfort Mode text size chosen with the slider
  const ORIGIN = location.origin && location.origin !== 'null' ? location.origin : location.href; // shown in the popup only
  const ROOT = document.documentElement;

  const SCALE = { min: 80, max: 200, step: 5, button: 10, normal: 100 };
  // Default Comfort Mode text size (the popup slider can change it).
  const COMFORT_SCALE = { min: 100, max: 200, step: 5, normal: 160 };
  const THEMES = ['default', 'light', 'dark', 'highContrast'];
  const THEME_CLASSES = { light: 'ev-theme-light', dark: 'ev-theme-dark', highContrast: 'ev-theme-hc' };
  const BOOLEAN_KEYS = ['readableFont', 'lineSpacing', 'letterSpacing', 'paragraphSpacing', 'bigCursor', 'focusMode'];
  const CLASS_FOR = {
    readableFont: 'ev-readable-font',
    lineSpacing: 'ev-line-spacing',
    letterSpacing: 'ev-letter-spacing',
    paragraphSpacing: 'ev-paragraph-spacing',
    bigCursor: 'ev-big-cursor',
    focusMode: 'ev-focus'
  };
  // Every setting that Comfort Mode changes (so turning it Off can restore them).
  const COMFORT_KEYS = ['textScale', 'theme', 'readableFont', 'lineSpacing', 'letterSpacing', 'paragraphSpacing', 'bigCursor'];
  // Raise this number whenever the Comfort Mode preset changes, so saved settings pick up the new preset.
  const COMFORT_PRESET_VERSION = 3;
  const DEFAULTS = Object.freeze({
    comfort: false, comfortVersion: 0, textScale: 100, theme: 'default',
    readableFont: false, lineSpacing: false, letterSpacing: false, paragraphSpacing: false,
    bigCursor: false, focusMode: false, comfortBackup: null
  });

  const SCALE_ATTR = 'data-ev-fs';
  const THEME_BG_ATTR = 'data-ev-bg';           // may be recoloured ("light" / "dark" = original)
  const THEME_KEEP_ATTR = 'data-ev-keep';       // has a background image: keep its own colours
  const THEME_BACKDROP_ATTR = 'data-ev-backdrop'; // original colour behind a picture ("light" / "dark")
  const THEME_ALPHA_VAR = '--ev-a';             // original see-through amount of a background
  const SCALE_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'OPTION', 'SELECT', 'TEMPLATE']);
  const THEME_SKIP_TAGS = new Set(['HTML', 'HEAD', 'BODY', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META',
    'VIDEO', 'CANVAS', 'PICTURE', 'SOURCE', 'IFRAME', 'OBJECT', 'EMBED']);
  const MAX_THEME_ELEMENTS = 20000;

  /* ---------- 2. Settings (validate, load, save) ---------- */
  let settings = { ...DEFAULTS };
  let comfortScale = COMFORT_SCALE.normal;

  function pick(obj, keys) {
    const out = {};
    keys.forEach((k) => { out[k] = obj[k]; });
    return out;
  }

  function clampScale(value) {
    const stepped = Math.round(value / SCALE.step) * SCALE.step;
    return Math.min(SCALE.max, Math.max(SCALE.min, stepped));
  }

  function clampComfort(value) {
    if (!Number.isFinite(value)) return COMFORT_SCALE.normal;
    const stepped = Math.round(value / COMFORT_SCALE.step) * COMFORT_SCALE.step;
    return Math.min(COMFORT_SCALE.max, Math.max(COMFORT_SCALE.min, stepped));
  }

  // Turns anything (including corrupt storage data) into a valid settings object.
  function sanitizeSettings(raw, includeBackup = true) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = { ...DEFAULTS };
    out.comfort = r.comfort === true;
    out.comfortVersion = out.comfort && Number.isFinite(Number(r.comfortVersion)) ? Number(r.comfortVersion) : 0;
    const scale = Number(r.textScale);
    out.textScale = Number.isFinite(scale) ? clampScale(scale) : SCALE.normal;
    out.theme = THEMES.includes(r.theme) ? r.theme : 'default';
    BOOLEAN_KEYS.forEach((k) => { out[k] = r[k] === true; });
    if (includeBackup && out.comfort && r.comfortBackup && typeof r.comfortBackup === 'object') {
      out.comfortBackup = pick(sanitizeSettings(r.comfortBackup, false), COMFORT_KEYS);
    }
    return out;
  }

  const isDefault = (s) => JSON.stringify(s) === JSON.stringify(DEFAULTS);
  const sameSettings = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function loadStored() {
    try {
      const data = await chrome.storage.local.get([STORAGE_KEY, COMFORT_SCALE_KEY]);
      const saved = data[STORAGE_KEY] && typeof data[STORAGE_KEY] === 'object' ? data[STORAGE_KEY] : {};
      return {
        settings: sanitizeSettings(saved[SITE_KEY]),
        comfort: clampComfort(Number(data[COMFORT_SCALE_KEY]))
      };
    } catch (err) {
      console.warn('EasyView: could not load settings', err);
      return { settings: { ...DEFAULTS }, comfort: COMFORT_SCALE.normal };
    }
  }

  let saveChain = Promise.resolve();
  function queueSave(task) {
    // Chained so two quick changes never write in the wrong order.
    saveChain = saveChain.then(task).catch((err) => console.warn('EasyView: could not save', err));
    return saveChain;
  }

  function saveSettings() {
    return queueSave(async () => {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const saved = data[STORAGE_KEY] && typeof data[STORAGE_KEY] === 'object' ? data[STORAGE_KEY] : {};
      if (isDefault(settings)) delete saved[SITE_KEY];
      else saved[SITE_KEY] = settings;
      await chrome.storage.local.set({ [STORAGE_KEY]: saved });
    });
  }

  function saveComfortScale() {
    const value = comfortScale;
    return queueSave(() => chrome.storage.local.set({ [COMFORT_SCALE_KEY]: value }));
  }

  // Applies a partial update coming from the popup. Unknown keys are ignored.
  function applyPatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    const next = { ...settings };
    BOOLEAN_KEYS.forEach((k) => { if (typeof patch[k] === 'boolean') next[k] = patch[k]; });
    if (THEMES.includes(patch.theme)) next.theme = patch.theme;
    if (typeof patch.textScale === 'number' && Number.isFinite(patch.textScale)) {
      next.textScale = clampScale(patch.textScale);
    }
    settings = sanitizeSettings(next);
  }

  // What Comfort Mode switches on. Edit this to change the Comfort Mode defaults.
  // If you change it, also raise COMFORT_PRESET_VERSION above.
  function comfortPreset() {
    return {
      textScale: comfortScale,   // set by the popup slider (default 160%)
      theme: 'highContrast',
      readableFont: true,
      lineSpacing: true,
      letterSpacing: true,
      paragraphSpacing: true,
      bigCursor: true
    };
  }

  function setComfort(enabled) {
    const next = { ...settings };
    if (enabled) {
      // Remember the "before" settings only the first time, so Off can undo Comfort Mode.
      if (!next.comfort) next.comfortBackup = pick(settings, COMFORT_KEYS);
      Object.assign(next, comfortPreset(), { comfort: true, comfortVersion: COMFORT_PRESET_VERSION });
    } else {
      if (!settings.comfort) return;
      Object.assign(next, next.comfortBackup || pick(DEFAULTS, COMFORT_KEYS),
        { comfort: false, comfortVersion: 0, comfortBackup: null });
    }
    settings = sanitizeSettings(next);
  }

  /* ---------- 3. Apply settings to the page ---------- */
  function whenBodyReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  const removeThemeClasses = () => Object.values(THEME_CLASSES).forEach((c) => ROOT.classList.remove(c));
  function addThemeClass() {
    if (THEME_CLASSES[settings.theme]) ROOT.classList.add(THEME_CLASSES[settings.theme]);
  }

  function applyClasses() {
    BOOLEAN_KEYS.forEach((k) => ROOT.classList.toggle(CLASS_FOR[k], settings[k]));
    removeThemeClasses();
    addThemeClass();
  }

  function applyAll() {
    applyClasses();
    applyTextScale();
    applyThemeTagging();
    applyCursorHalo();
    applyFocusExtras();
    updateBar();
  }

  /* ---------- 4. Page observer (new content and class changes) ---------- */
  const scaleState = { tagged: false };
  const themeState = { tagged: false };
  const pageState = { observer: null, added: new Set(), changed: new Set(), timer: null };

  function ensurePageObserver() {
    if (pageState.observer || !document.body) return;
    pageState.observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'childList') {
          rec.addedNodes.forEach((n) => {
            if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) pageState.added.add(n);
          });
        } else if (rec.type === 'attributes' && themeState.tagged && rec.target.nodeType === Node.ELEMENT_NODE) {
          pageState.changed.add(rec.target);
        }
      }
      if (!pageState.timer) pageState.timer = setTimeout(processPending, 300);
    });
    pageState.observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class']
    });
  }

  function maybeStopPageObserver() {
    if (scaleState.tagged || themeState.tagged) return;
    if (pageState.observer) { pageState.observer.disconnect(); pageState.observer = null; }
    if (pageState.timer) { clearTimeout(pageState.timer); pageState.timer = null; }
    pageState.added.clear();
    pageState.changed.clear();
  }

  function processPending() {
    pageState.timer = null;
    const added = Array.from(pageState.added).filter((n) => n.isConnected);
    const changed = Array.from(pageState.changed).filter((n) => n.isConnected);
    pageState.added.clear();
    pageState.changed.clear();
    if ((!scaleState.tagged && !themeState.tagged) || (!added.length && !changed.length)) return;

    const scaledWasOn = ROOT.classList.contains('ev-scaled');
    ROOT.classList.remove('ev-scaled'); // measure ORIGINAL sizes and colours, not our own
    removeThemeClasses();
    try {
      if (scaleState.tagged && added.length) tagTextElements(added);
      if (themeState.tagged) {
        tagThemeElements(added, true);    // new content: look at the whole new subtree
        tagThemeElements(changed, false); // class change: re-check only that element
      }
    } finally {
      if (scaledWasOn) ROOT.classList.add('ev-scaled');
      addThemeClass();
    }
  }

  /* ---------- 5. Text size ---------- */
  function collectTextParents(roots) {
    const found = new Set();
    const consider = (el) => {
      if (el && !el.hasAttribute(SCALE_ATTR) && !(el instanceof SVGElement) && !SCALE_SKIP_TAGS.has(el.tagName)) {
        found.add(el);
      }
    };
    roots.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) { consider(node.parentElement); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.nodeValue.trim()) consider(walker.currentNode.parentElement);
      }
    });
    return Array.from(found);
  }

  // Records each element's ORIGINAL font size once. Must run while html.ev-scaled is off.
  function tagTextElements(roots) {
    const elements = collectTextParents(roots);
    const sizes = elements.map((el) => parseFloat(getComputedStyle(el).fontSize)); // all reads first
    elements.forEach((el, i) => {                                                    // then all writes
      if (sizes[i] > 0) {
        el.setAttribute(SCALE_ATTR, '');
        el.style.setProperty('--ev-fs', sizes[i] + 'px');
      }
    });
  }

  function teardownTextScale() {
    scaleState.tagged = false;
    ROOT.classList.remove('ev-scaled');
    ROOT.style.removeProperty('--ev-scale');
    document.querySelectorAll('[' + SCALE_ATTR + ']').forEach((el) => {
      el.removeAttribute(SCALE_ATTR);
      el.style.removeProperty('--ev-fs');
    });
    maybeStopPageObserver();
  }

  function applyTextScale() {
    if (settings.textScale === SCALE.normal) { teardownTextScale(); return; }
    whenBodyReady(() => {
      if (settings.textScale === SCALE.normal) return; // changed again while waiting
      ROOT.style.setProperty('--ev-scale', String(settings.textScale / 100));
      if (!scaleState.tagged) {
        ROOT.classList.remove('ev-scaled');
        tagTextElements([document.body]);
        scaleState.tagged = true;
        ensurePageObserver();
      }
      ROOT.classList.add('ev-scaled'); // changing --ev-scale alone re-scales: nothing accumulates
    });
  }

  /* ---------- 6. Colour modes: record the page's ORIGINAL colours ---------- */
  function colorAlpha(value) {
    if (!value || value === 'transparent') return 0;
    const m = value.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (parts.length < 4) return 1;
      const a = parseFloat(parts[3]);
      if (Number.isNaN(a)) return 1;
      return parts[3].endsWith('%') ? a / 100 : a;
    }
    const slash = value.match(/\/\s*([\d.]+)(%?)\s*\)/);
    if (slash) return slash[2] ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
    return 1;
  }

  function colorIsLight(value) {
    const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (!m) return true;
    return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 > 0.5;
  }

  // What colour is behind this element's parent chain? 'light' | 'dark' | null (a background image is behind).
  // cache[node] = the answer for something sitting directly inside node.
  function backdropFor(el, cache) {
    const trail = [];
    let result = 'light'; // the browser's default white page
    let node = el.parentElement;
    while (node) {
      if (cache.has(node)) { result = cache.get(node); break; }
      trail.push(node);
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') { result = null; break; }
      if (colorAlpha(cs.backgroundColor) >= 0.5) { result = colorIsLight(cs.backgroundColor) ? 'light' : 'dark'; break; }
      node = node.parentElement;
    }
    trail.forEach((n) => cache.set(n, result));
    return result;
  }

  function clearThemeTags(el) {
    el.removeAttribute(THEME_BG_ATTR);
    el.removeAttribute(THEME_KEEP_ATTR);
    el.removeAttribute(THEME_BACKDROP_ATTR);
    el.style.removeProperty(THEME_ALPHA_VAR);
  }

  // For each element decide:
  //   <img>           : remember the original backdrop (data-ev-backdrop) so a transparent logo can get a backing colour
  //   has bg image    : data-ev-keep, so it and its children keep their own colours
  //   solid-ish bg    : data-ev-bg (+ --ev-a if see-through), so the theme may recolour it and keep the see-through amount
  //   anything else   : left completely alone (images and photos stay visible)
  // Must run while the theme classes are removed so the ORIGINAL colours are read.
  function tagThemeElements(roots, deep) {
    if (!roots.length) return;
    const docW = ROOT.clientWidth || window.innerWidth;
    const docH = ROOT.scrollHeight || window.innerHeight;

    let targets = [];
    roots.forEach((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      targets.push(node);
      if (deep) node.querySelectorAll('*').forEach((el) => targets.push(el));
    });
    if (targets.length > MAX_THEME_ELEMENTS) targets = targets.slice(0, MAX_THEME_ELEMENTS);

    const cache = new Map();

    // Read phase (no writes, so no repeated layout work)
    const results = targets.map((el) => {
      if (el instanceof SVGElement) return null;
      if (el.tagName === 'IMG') return { el, backdrop: backdropFor(el, cache) };
      if (THEME_SKIP_TAGS.has(el.tagName)) return null;

      const cs = getComputedStyle(el);
      const alpha = colorAlpha(cs.backgroundColor);

      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const r = el.getBoundingClientRect();
        if (r.width >= docW * 0.9 && r.height >= docH * 0.9) return null; // page-wide wrapper: leave alone
        return { el, keep: true, backdrop: alpha < 0.5 ? backdropFor(el, cache) : null };
      }
      if (alpha >= 0.5) {
        return { el, bg: colorIsLight(cs.backgroundColor) ? 'light' : 'dark', alpha };
      }
      return null;
    });

    // Write phase
    targets.forEach((el) => {
      if (el.hasAttribute(THEME_BG_ATTR) || el.hasAttribute(THEME_KEEP_ATTR) || el.hasAttribute(THEME_BACKDROP_ATTR)) {
        clearThemeTags(el);
      }
    });
    results.forEach((r) => {
      if (!r) return;
      if (r.bg) {
        r.el.setAttribute(THEME_BG_ATTR, r.bg);
        if (r.alpha < 0.99) r.el.style.setProperty(THEME_ALPHA_VAR, r.alpha.toFixed(2));
      }
      if (r.keep) r.el.setAttribute(THEME_KEEP_ATTR, '');
      if (r.backdrop) r.el.setAttribute(THEME_BACKDROP_ATTR, r.backdrop);
    });
  }

  // Re-reads the whole page's original colours (used at start and after the page finishes loading).
  function retagTheme() {
    if (!document.body) return;
    removeThemeClasses(); // synchronous: nothing is painted while the classes are off
    try { tagThemeElements([document.body], true); } finally { addThemeClass(); }
  }

  function teardownThemeTags() {
    themeState.tagged = false;
    document.querySelectorAll(
      '[' + THEME_BG_ATTR + '],[' + THEME_KEEP_ATTR + '],[' + THEME_BACKDROP_ATTR + ']'
    ).forEach(clearThemeTags);
    maybeStopPageObserver();
  }

  function applyThemeTagging() {
    if (settings.theme === 'default') { teardownThemeTags(); return; }
    whenBodyReady(() => {
      if (settings.theme === 'default') return; // changed again while waiting
      if (!themeState.tagged) {
        retagTheme();
        themeState.tagged = true;
        ensurePageObserver();
      }
      addThemeClass();
    });
  }

  /* ---------- 7. Cursor halo (ring that follows the mouse) ---------- */
  let haloOn = false;
  let haloRaf = 0;
  const haloPos = { x: 0, y: 0 };

  function onHaloMove(e) {
    haloPos.x = e.clientX;
    haloPos.y = e.clientY;
    if (haloRaf) return;
    haloRaf = requestAnimationFrame(() => {
      haloRaf = 0;
      if (!ui.halo) return;
      ui.halo.style.display = 'block';
      ui.halo.style.transform = 'translate(' + haloPos.x + 'px,' + haloPos.y + 'px)';
    });
  }
  function hideHalo() { if (ui.halo) ui.halo.style.display = 'none'; }

  function applyCursorHalo() {
    if (settings.bigCursor && !haloOn) {
      haloOn = true;
      whenBodyReady(() => {
        if (!haloOn) return;
        ensureUI();
        document.addEventListener('mousemove', onHaloMove, { passive: true });
        ROOT.addEventListener('mouseleave', hideHalo);
      });
    } else if (!settings.bigCursor && haloOn) {
      haloOn = false;
      document.removeEventListener('mousemove', onHaloMove);
      ROOT.removeEventListener('mouseleave', hideHalo);
      hideHalo();
    }
  }

  /* ---------- 8. Focus Mode extras (CSS hides ads; this pauses videos and looping animations) ---------- */
  let pausedVideos = [];
  let frozenAnimations = [];
  let freezeTimers = [];

  // Pauses only animations that loop forever (spinners, auto-sliding banners).
  // Animations that finish by themselves (fade-ins, image reveals) are left alone, so images still appear.
  function freezeLoopingAnimations() {
    if (!settings.focusMode || typeof document.getAnimations !== 'function') return;
    document.getAnimations().forEach((anim) => {
      try {
        const timing = anim.effect && anim.effect.getComputedTiming ? anim.effect.getComputedTiming() : null;
        if (timing && timing.iterations === Infinity && anim.playState === 'running') {
          anim.pause();
          frozenAnimations.push(anim);
        }
      } catch (e) { /* ignore */ }
    });
  }

  function clearFreezeTimers() {
    freezeTimers.forEach((t) => clearTimeout(t));
    freezeTimers = [];
  }

  function applyFocusExtras() {
    if (settings.focusMode) {
      whenBodyReady(() => {
        if (!settings.focusMode) return;
        document.querySelectorAll('video[autoplay]:not([controls])').forEach((v) => {
          if (!v.paused && !pausedVideos.includes(v)) { v.pause(); pausedVideos.push(v); }
        });
        freezeLoopingAnimations();
        clearFreezeTimers();
        freezeTimers.push(setTimeout(freezeLoopingAnimations, 1500), setTimeout(freezeLoopingAnimations, 4000));
      });
    } else {
      clearFreezeTimers();
      pausedVideos.forEach((v) => { try { v.play().catch(() => {}); } catch (e) { /* ignore */ } });
      pausedVideos = [];
      frozenAnimations.forEach((a) => { try { a.play(); } catch (e) { /* ignore */ } });
      frozenAnimations = [];
    }
  }

  /* ---------- 9. Read Aloud ---------- */
  const speechSupported = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  const reader = { state: 'idle', queue: [], index: 0, token: 0, utterance: null, highlighted: null };

  const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th';
  const EXCLUDE_SELECTOR = 'nav,footer,aside,form,body > header,[role="navigation"],[role="contentinfo"],' +
    '[role="complementary"],[role="search"],[role="banner"],[aria-hidden="true"],[hidden],' +
    'script,style,noscript,template,button,select';
  const SENTENCE_RE = /[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g;

  const cleanText = (t) => (t || '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function findMainContainer() {
    const main = document.querySelector('main, [role="main"]');
    if (main) return main;
    const articles = document.querySelectorAll('article');
    return articles.length === 1 ? articles[0] : document.body;
  }

  function collectReadingItems() {
    const selection = window.getSelection ? cleanText(window.getSelection().toString()) : '';
    if (selection) return [{ text: selection, block: null }];

    const container = findMainContainer();
    const seen = new Set();
    const items = [];
    container.querySelectorAll(BLOCK_SELECTOR).forEach((el) => {
      if (el.querySelector(BLOCK_SELECTOR)) return;      // read only the innermost block
      if (el.closest(EXCLUDE_SELECTOR)) return;           // menus, footers, forms, hidden
      if (!isVisible(el)) return;
      const text = cleanText(el.innerText);
      if (text.length < 2 || seen.has(text)) return;      // skip duplicates
      seen.add(text);
      items.push({ text, block: el });
    });
    if (items.length) return items;

    // Fallback for pages built only from <div>s: use longer visible lines of text.
    (container.innerText || '').split(/\n+/).map(cleanText).forEach((line) => {
      if (line.length >= 40 && !seen.has(line)) { seen.add(line); items.push({ text: line, block: null }); }
    });
    return items;
  }

  // Short chunks keep Chrome's speech engine from stopping mid-way and make Pause responsive.
  function splitIntoChunks(text, max) {
    const sentences = text.match(SENTENCE_RE) || [text];
    const chunks = [];
    let buf = '';
    const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };
    for (const sentence of sentences) {
      if (sentence.length > max) {
        flush();
        let part = '';
        for (const word of sentence.split(/\s+/)) {
          if ((part + ' ' + word).length > max && part) { chunks.push(part.trim()); part = ''; }
          part += (part ? ' ' : '') + word;
        }
        if (part.trim()) chunks.push(part.trim());
      } else if ((buf + sentence).length > max) {
        flush();
        buf = sentence;
      } else {
        buf += sentence;
      }
    }
    flush();
    return chunks;
  }

  function clearHighlight() {
    if (reader.highlighted) reader.highlighted.classList.remove('ev-reading-current');
    reader.highlighted = null;
  }

  function highlightBlock(el) {
    if (el === reader.highlighted) return;
    clearHighlight();
    if (!el) return;
    el.classList.add('ev-reading-current');
    reader.highlighted = el;
    try {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    } catch (e) { /* ignore */ }
  }

  const readerInfo = () => ({ state: reader.state, supported: speechSupported });

  function notifyReaderChanged() {
    updateBar();
    try {
      chrome.runtime.sendMessage({ type: 'EV_READER_CHANGED', reader: readerInfo() }).catch(() => {});
    } catch (e) { /* popup closed or extension reloaded */ }
  }

  function speakCurrent() {
    const token = reader.token;
    if (reader.index >= reader.queue.length) { readerStop(); return; }
    const item = reader.queue[reader.index];
    highlightBlock(item.block);
    const u = new SpeechSynthesisUtterance(item.text);
    if (document.documentElement.lang) u.lang = document.documentElement.lang;
    u.rate = 0.95;
    u.onend = () => {
      if (token !== reader.token) return;
      reader.index += 1;
      speakCurrent();
    };
    u.onerror = (e) => {
      if (token !== reader.token) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('EasyView: speech error', e.error);
      readerStop();
    };
    reader.utterance = u; // keep a reference: Chrome can garbage-collect it mid-speech
    window.speechSynthesis.speak(u);
  }

  function readerPlay() {
    if (!speechSupported) return 'Read Aloud is not supported in this browser.';
    if (reader.state === 'paused') { readerResume(); return undefined; }
    if (reader.state === 'playing') return undefined;
    const items = collectReadingItems();
    if (!items.length) return 'No readable text was found on this page. Try selecting some text first.';
    window.speechSynthesis.cancel();
    reader.token += 1;
    reader.queue = [];
    items.forEach((item) => {
      splitIntoChunks(item.text, 180).forEach((chunk) => reader.queue.push({ text: chunk, block: item.block }));
    });
    reader.index = 0;
    reader.state = 'playing';
    speakCurrent();
    notifyReaderChanged();
    return undefined;
  }

  function readerPause() {
    if (!speechSupported || reader.state !== 'playing') return;
    window.speechSynthesis.pause();
    reader.state = 'paused';
    notifyReaderChanged();
  }

  function readerResume() {
    if (!speechSupported || reader.state !== 'paused') return;
    window.speechSynthesis.resume();
    reader.state = 'playing';
    notifyReaderChanged();
  }

  function readerStop() {
    reader.token += 1; // invalidates callbacks from the utterance being cancelled
    if (speechSupported) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    reader.state = 'idle';
    reader.queue = [];
    reader.index = 0;
    reader.utterance = null;
    clearHighlight();
    notifyReaderChanged();
  }

  window.addEventListener('pagehide', () => {
    if (speechSupported) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
  });

  /* ---------- 10. Floating UI (closed Shadow DOM: page styles cannot touch it) ---------- */
  const ui = { host: null, halo: null, bar: null, label: null, pause: null, stop: null, exitFocus: null };

  const UI_HTML = `
    <style>
      #halo { position: fixed; left: 0; top: 0; width: 56px; height: 56px; margin: -28px 0 0 -28px;
        box-sizing: border-box; border: 4px solid #ff9800; border-radius: 50%;
        background: rgba(255, 152, 0, 0.18); pointer-events: none; display: none; z-index: 2147483646; }
      #bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483647;
        display: none; align-items: center; gap: 10px; padding: 10px 14px; background: #14213d; color: #ffffff;
        border: 3px solid #ffffff; border-radius: 14px; box-shadow: 0 4px 18px rgba(0,0,0,.4);
        font: 600 18px/1.3 Verdana, Tahoma, Arial, sans-serif; }
      #bar.visible { display: flex; }
      button { font: inherit; min-height: 44px; padding: 6px 16px; border: 2px solid #ffffff; border-radius: 10px;
        background: #ffffff; color: #14213d; cursor: pointer; }
      button:hover { background: #ffd166; }
      button:focus-visible { outline: 4px solid #ffd166; outline-offset: 2px; }
      [hidden] { display: none !important; }
    </style>
    <div id="halo"></div>
    <div id="bar" role="region" aria-label="EasyView controls">
      <span id="label" aria-live="polite">EasyView</span>
      <button id="pause" type="button" hidden>Pause</button>
      <button id="stop" type="button" hidden>Stop reading</button>
      <button id="exitFocus" type="button" hidden>Exit Focus Mode</button>
    </div>`;

  function ensureUI() {
    if (ui.host) return;
    const host = document.createElement('easyview-ui');
    host.style.setProperty('display', 'contents', 'important');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = UI_HTML;
    ui.halo = shadow.getElementById('halo');
    ui.bar = shadow.getElementById('bar');
    ui.label = shadow.getElementById('label');
    ui.pause = shadow.getElementById('pause');
    ui.stop = shadow.getElementById('stop');
    ui.exitFocus = shadow.getElementById('exitFocus');
    ui.pause.addEventListener('click', () => (reader.state === 'paused' ? readerResume() : readerPause()));
    ui.stop.addEventListener('click', readerStop);
    ui.exitFocus.addEventListener('click', () => { applyPatch({ focusMode: false }); commit(); });
    ROOT.appendChild(host);
    ui.host = host;
  }

  function updateBar() {
    const reading = reader.state !== 'idle';
    const needed = reading || settings.focusMode;
    if (!needed && !ui.host) return;
    whenBodyReady(() => {
      ensureUI();
      ui.pause.hidden = !reading;
      ui.stop.hidden = !reading;
      ui.exitFocus.hidden = !settings.focusMode;
      ui.pause.textContent = reader.state === 'paused' ? 'Resume' : 'Pause';
      ui.label.textContent = reading
        ? (reader.state === 'paused' ? 'Reading paused' : 'Reading aloud')
        : 'Focus Mode is on';
      ui.bar.classList.toggle('visible', needed);
    });
  }

  /* ---------- 11. Messages from the popup ---------- */
  let ready = Promise.resolve();

  async function commit() {
    applyAll();
    await saveSettings();
  }

  function stateResponse(notice) {
    return {
      ok: true,
      notice,
      state: {
        origin: ORIGIN,
        settings,
        comfortScale,
        reader: readerInfo(),
        limits: { min: SCALE.min, max: SCALE.max, step: SCALE.step, button: SCALE.button }
      }
    };
  }

  // To add a feature later (for example AI), add one more handler here.
  const handlers = {
    async EV_GET_STATE() {
      await ready;
      return stateResponse();
    },
    async EV_UPDATE(msg) {
      await ready;
      applyPatch(msg.patch);
      await commit();
      return stateResponse();
    },
    async EV_COMFORT(msg) {
      await ready;
      setComfort(msg.enabled === true);
      await commit();
      return stateResponse();
    },
    async EV_COMFORT_SCALE(msg) {
      await ready;
      const value = Number(msg.value);
      if (!Number.isFinite(value)) throw new Error('Invalid comfort size');
      comfortScale = clampComfort(value);
      await saveComfortScale();
      if (settings.comfort) {            // Comfort Mode is on: show the new size straight away
        applyPatch({ textScale: comfortScale });
        await commit();
      }
      return stateResponse();
    },
    async EV_TEXT_SIZE(msg) {
      await ready;
      let next = settings.textScale;
      if (msg.action === 'increase') next += SCALE.button;
      else if (msg.action === 'decrease') next -= SCALE.button;
      else if (msg.action === 'reset') next = SCALE.normal;
      else throw new Error('Unknown text size action');
      applyPatch({ textScale: next });
      await commit();
      return stateResponse();
    },
    async EV_RESET() {
      await ready;
      readerStop();
      settings = { ...DEFAULTS };
      await commit();
      return stateResponse();
    },
    async EV_READ(msg) {
      await ready;
      let notice;
      switch (msg.action) {
        case 'play': notice = readerPlay(); break;
        case 'pause': readerPause(); break;
        case 'resume': readerResume(); break;
        case 'stop': readerStop(); break;
        default: throw new Error('Unknown read action');
      }
      return stateResponse(notice);
    }
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (!msg || typeof msg.type !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, msg.type)) return false;
    Promise.resolve()
      .then(() => handlers[msg.type](msg))
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // keep the channel open for the async response
  });

  // Keep all open tabs in sync with each other.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[COMFORT_SCALE_KEY]) comfortScale = clampComfort(Number(changes[COMFORT_SCALE_KEY].newValue));
    if (changes[STORAGE_KEY]) {
      const saved = changes[STORAGE_KEY].newValue || {};
      const next = sanitizeSettings(saved[SITE_KEY]);
      if (sameSettings(next, settings)) return;
      settings = next;
      applyAll();
    }
  });

  /* ---------- 12. Start-up ---------- */
  ready = loadStored().then(async (stored) => {
    settings = stored.settings;
    comfortScale = stored.comfort;
    // Saved with an older Comfort Mode preset: bring it up to date once.
    if (settings.comfort && settings.comfortVersion < COMFORT_PRESET_VERSION) {
      setComfort(true);
      await saveSettings();
    }
    applyAll();
  });

  // Once the page has fully loaded (all stylesheets and images), re-read the original colours
  // and freeze any looping animations that started late.
  window.addEventListener('load', () => {
    if (themeState.tagged) retagTheme();
    if (settings.focusMode) freezeLoopingAnimations();
  });
})();