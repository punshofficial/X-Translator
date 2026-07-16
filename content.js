(function xTranslatorContentScript() {
  "use strict";

  const {
    escapeHtml,
    languagesMatch,
    normalizePlainText,
  } = XTranslatorCore;

  const PRIMARY_SELECTOR = '[data-testid="tweetText"]';
  const PUBLIC_ARTICLE_SELECTOR = 'article[data-tweet-id][itemtype="https://schema.org/SocialMediaPosting"]';
  const OWNED_SELECTOR = "[data-xtr-owned]";
  const TARGET_LANGUAGE = "ru";
  const BATCH_SIZE = 4;
  const BATCH_CHARACTERS = 30_000;
  const RETRY_DELAY = 5_000;
  const MAX_RETRY_DELAY = 30_000;
  const EXPANSION_PREFETCH_LIMIT = 40;
  const INITIAL_LOADING_DELAY = 350;

  const states = new WeakMap();
  const trackedStates = new Set();
  const queue = [];
  let enabled = true;
  let flushTimer = null;
  let flushInFlight = false;
  let scanTimer = null;
  let requestSequence = 0;
  const expansionPrefetches = new Map();
  const expansionPrefetchQueue = [];
  let expansionPrefetchActive = false;

  start();

  async function start() {
    const settings = await storageGet({ enabled: true });
    enabled = settings.enabled !== false;
    observePage();
    scanDocument();

    document.addEventListener("click", handleExpansionClick, true);
    window.addEventListener("pageshow", scheduleScan, true);
    window.addEventListener("popstate", scheduleScan, true);
    window.addEventListener("hashchange", scheduleScan, true);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleScan();
    });
    setInterval(() => {
      sweepDetachedStates();
      if (enabled) scanDocument();
    }, 4_000);
  }

  function observePage() {
    const observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      let urgent = false;
      let shouldScan = false;
      for (const mutation of mutations) {
        if (isOwnedMutation(mutation)) continue;
        shouldScan = true;
        urgent ||= mutation.type === "childList"
          && [...mutation.removedNodes].some((node) => (
            node.nodeType === Node.ELEMENT_NODE
            && (node.matches?.(OWNED_SELECTOR) || node.querySelector?.(OWNED_SELECTOR))
          ));
      }
      if (urgent) {
        if (scanTimer !== null) {
          clearTimeout(scanTimer);
          scanTimer = null;
        }
        scanDocument();
      } else if (shouldScan) {
        scheduleScan(60);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"],
      childList: true,
      characterData: true,
      subtree: true,
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;

      if (changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        if (!enabled) {
          removeAllTranslations();
          return;
        }
      }

      if (changes.enabled) {
        for (const state of trackedStates) {
          if (state.status === "error") {
            state.status = "new";
          }
        }
      }
      if (enabled) scheduleScan();
    });
  }

  function handleExpansionClick(event) {
    const control = event.target?.closest?.('button, a, [role="button"]');
    if (!control || !isExpandableText(control.textContent)) return;
    const article = control.closest('article[data-testid="tweet"]') || control.closest("article");
    const source = article?.querySelector(PRIMARY_SELECTOR);
    const state = source ? states.get(source) : null;
    if (state?.view) showExpansionPending(state.view);

    setTimeout(() => {
      if (enabled) scanDocument();
    }, 0);
    setTimeout(() => {
      if (enabled) scanDocument();
    }, 60);
  }

  function isOwnedMutation(mutation) {
    const target = mutation.target.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target.parentElement;
    return Boolean(target?.closest?.(OWNED_SELECTOR));
  }

  function scheduleScan(delay = 60) {
    if (!enabled) return;
    if (scanTimer !== null) {
      if (delay !== 0) return;
      clearTimeout(scanTimer);
    }
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanDocument();
    }, delay);
  }

  function scanDocument() {
    if (!enabled) return;

    const targets = new Set();
    document.querySelectorAll(PRIMARY_SELECTOR).forEach((element) => {
      if (!element.closest(OWNED_SELECTOR)) targets.add(element);
    });

    document.querySelectorAll(PUBLIC_ARTICLE_SELECTOR).forEach((article) => {
      if (article.querySelector(PRIMARY_SELECTOR)) return;
      const element = findPublicPostText(article);
      if (element) targets.add(element);
    });

    [...targets]
      .sort((left, right) => elementPriority(left) - elementPriority(right))
      .forEach(processTarget);
  }

  function elementPriority(element) {
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 800;
    if (rect.bottom >= 0 && rect.top <= viewportHeight) {
      return Math.abs(((rect.top + rect.bottom) / 2) - (viewportHeight / 2));
    }
    if (rect.top > viewportHeight) return viewportHeight + rect.top - viewportHeight;
    return viewportHeight + Math.abs(rect.bottom);
  }

  function findPublicPostText(article) {
    const source = article.querySelector(':scope > meta[itemprop="articleBody"]')
      || article.querySelector('meta[itemprop="articleBody"]');
    const expected = normalizePlainText(source?.getAttribute("content"));
    if (!expected) return null;

    const candidates = [...article.querySelectorAll('[dir="auto"]')]
      .filter((element) => !element.closest(OWNED_SELECTOR))
      .filter((element) => normalizePlainText(element.textContent) === expected);

    return candidates.find((element) => (
      ![...element.querySelectorAll('[dir="auto"]')]
        .some((child) => normalizePlainText(child.textContent) === expected)
    )) || candidates[0] || null;
  }

  function processTarget(element) {
    if (!enabled || !element.isConnected || element.closest(OWNED_SELECTOR)) return;

    const request = buildRequest(element);
    if (!request.plainText || request.plainText.length < 2) return;

    // Do not inherit <html lang>: on public X pages it describes the interface,
    // not the post. When the text container has no own language, let Bing
    // detect it from the post body.
    const sourceLanguage = element.getAttribute("lang") || "";
    if (languagesMatch(sourceLanguage, TARGET_LANGUAGE)) return;

    const fingerprint = `${request.plainText}\u0000${request.html}`;
    const previous = states.get(element);
    if (previous && previous.fingerprint === fingerprint) {
      if (["queued", "loading", "translated", "skipped"].includes(previous.status)) return;
      if (previous.status === "error" && Date.now() < previous.retryAt) return;
    }

    const location = locateTarget(element);
    const reusableState = previous?.view
      ? previous
      : findAdjacentViewState(element)
        || findContainerViewState(location, request.plainText);
    const reusableView = reusableState?.view || null;
    const isExpansionReplacement = Boolean(
      reusableState
      && isExpandableText(reusableState.plainText)
      && !isExpandableText(request.plainText)
      && request.plainText.length > expansionBase(reusableState.plainText).length + 8,
    );

    if (reusableState) {
      reusableState.status = "superseded";
      trackedStates.delete(reusableState);
      if (reusableState.element !== element) states.delete(reusableState.element);
    }
    if (previous && previous !== reusableState) cleanupState(previous);

    const state = {
      element,
      fingerprint,
      plainText: request.plainText,
      html: request.html,
      tokens: request.tokens,
      status: "new",
      requestId: String(++requestSequence),
      retryAt: 0,
      retryCount: Math.max(previous?.retryCount || 0, reusableState?.retryCount || 0),
      loadingTimer: null,
      pendingElement: null,
      view: reusableView,
      containerElement: location.containerElement,
      targetIndex: location.targetIndex,
      postKey: location.postKey,
      isExpandable: isExpandableText(request.plainText),
    };
    if (reusableView) {
      location.containerElement
        ?.querySelectorAll?.('[data-xtr-owned="expansion-status"]')
        .forEach((indicator) => {
          if (indicator !== reusableView.expansionElement) indicator.remove();
        });
      reusableView.owner = state;
      reusableView.sourceElement = element;
      if (element.previousElementSibling !== reusableView.metaElement) {
        element.before(reusableView.metaElement);
      }
      if (element.nextElementSibling !== reusableView.translatedElement) {
        element.after(reusableView.translatedElement);
      }
      if (reusableView.expansionElement) {
        reusableView.translatedElement.after(reusableView.expansionElement);
      }
      setOriginalVisible(reusableView, reusableView.showingOriginal);
    }
    states.set(element, state);
    trackedStates.add(state);

    const prefetched = matchingExpansionPrefetch(state);
    if (prefetched?.status === "ready") {
      applyTranslation(state, prefetched.result);
      return;
    }

    if (isExpansionReplacement) {
      showExpansionPending(state.view);
      const pending = expansionPrefetches.get(state.postKey);
      if (pending && ["queued", "loading"].includes(pending.status)) {
        waitForExpansionPrefetch(state, pending);
        return;
      }
    }

    enqueueState(state);
  }

  function enqueueState(state) {
    if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
    state.status = "queued";
    if (!queue.includes(state)) queue.push(state);
    scheduleInitialLoading(state);
    scheduleFlush();
  }

  function findAdjacentViewState(element) {
    const meta = element.previousElementSibling;
    const translation = element.nextElementSibling;
    if (!meta || !translation) return null;

    for (const state of trackedStates) {
      if (state.view?.metaElement === meta && state.view?.translatedElement === translation) {
        return state;
      }
    }
    return null;
  }

  function locateTarget(element) {
    const containerElement = element.closest('article[data-testid="tweet"]')
      || element.closest("article")
      || element.parentElement;
    if (!containerElement) {
      return { containerElement: null, targetIndex: -1, postKey: "" };
    }
    const targets = [...containerElement.querySelectorAll(PRIMARY_SELECTOR)];
    const time = containerElement.querySelector('a[href*="/status/"] time');
    const statusLink = time?.closest?.("a")
      || containerElement.querySelector('a[href*="/status/"]');
    return {
      containerElement,
      targetIndex: targets.indexOf(element),
      postKey: statusLink?.getAttribute?.("href") || "",
    };
  }

  function findContainerViewState(location, plainText) {
    if (!location.containerElement && !location.postKey) return null;
    for (const state of trackedStates) {
      if (!state.view) continue;
      const sameContainer = state.containerElement === location.containerElement;
      const samePost = location.postKey && state.postKey === location.postKey;
      if (!sameContainer && !samePost) continue;
      if (state.targetIndex !== location.targetIndex) continue;
      if (textsRepresentSamePost(state.plainText, plainText)) return state;
    }
    return null;
  }

  function textsRepresentSamePost(previousText, nextText) {
    const previousBase = expansionBase(previousText);
    const nextBase = expansionBase(nextText);
    if (!previousBase || !nextBase) return false;
    if (previousBase === nextBase) return true;
    const shorter = previousBase.length <= nextBase.length ? previousBase : nextBase;
    const longer = previousBase.length <= nextBase.length ? nextBase : previousBase;
    return shorter.length >= 24 && longer.startsWith(shorter);
  }

  function expansionBase(value) {
    return normalizePlainText(value)
      .replace(/(?:\s|\n)*(?:Показать\s+(?:ещё|еще|больше)|Show\s+more)\s*$/iu, "")
      .replace(/[.…]+$/u, "")
      .trim();
  }

  function isExpandableText(value) {
    return /(?:^|\s)(?:Показать\s+(?:ещё|еще|больше)|Show\s+more)\s*$/iu
      .test(normalizePlainText(value));
  }

  function matchingExpansionPrefetch(state) {
    if (!state.postKey) return null;
    const entry = expansionPrefetches.get(state.postKey);
    return entry?.plainText === state.plainText && entry?.html === state.html ? entry : null;
  }

  function waitForExpansionPrefetch(state, entry) {
    state.status = "loading";
    if (entry.status === "queued") {
      const index = expansionPrefetchQueue.indexOf(entry);
      if (index > 0) {
        expansionPrefetchQueue.splice(index, 1);
        expansionPrefetchQueue.unshift(entry);
      }
    }

    entry.promise.then((resolved) => {
      if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
      if (
        resolved.status === "ready"
        && resolved.plainText === state.plainText
        && resolved.html === state.html
      ) {
        applyTranslation(state, resolved.result);
        return;
      }
      enqueueState(state);
    });
  }

  function ensureExpansionPrefetch(state) {
    if (!enabled || !state.isExpandable || !state.postKey) return;
    if (expansionPrefetches.has(state.postKey)) return;

    let resolveEntry;
    const entry = {
      postKey: state.postKey,
      truncatedBase: expansionBase(state.plainText),
      status: "queued",
      plainText: "",
      html: "",
      result: null,
      promise: new Promise((resolve) => {
        resolveEntry = resolve;
      }),
      resolve: null,
    };
    entry.resolve = resolveEntry;
    expansionPrefetches.set(entry.postKey, entry);
    expansionPrefetchQueue.push(entry);
    trimExpansionPrefetches();
    runExpansionPrefetchQueue();
  }

  async function runExpansionPrefetchQueue() {
    if (expansionPrefetchActive) return;
    expansionPrefetchActive = true;

    try {
      while (enabled && expansionPrefetchQueue.length) {
        const entry = expansionPrefetchQueue.shift();
        if (expansionPrefetches.get(entry.postKey) !== entry) continue;
        entry.status = "loading";

        try {
          const fullText = await fetchFullPostText(entry.postKey, entry.truncatedBase);
          const request = buildTextRequest(fullText);
          const response = await runtimeMessage({
            type: "TRANSLATE_BATCH",
            items: [{
              id: `prefetch:${entry.postKey}`,
              html: request.html,
              plainText: request.plainText,
            }],
          });
          const result = response?.ok ? response.results?.[0] : null;
          if (!result?.translatedHtml) throw new Error(response?.error || "Не удалось подготовить полный перевод.");
          entry.plainText = request.plainText;
          entry.html = request.html;
          entry.result = result;
          entry.status = "ready";
        } catch (error) {
          entry.status = "error";
          console.debug("[X Translator] Не удалось заранее перевести продолжение:", error);
        } finally {
          entry.resolve(entry);
          trimExpansionPrefetches();
        }
      }
    } finally {
      expansionPrefetchActive = false;
    }
  }

  async function fetchFullPostText(postKey, truncatedBase) {
    const url = new URL(postKey, location.origin);
    const response = await fetch(url.href, {
      cache: "force-cache",
      credentials: "omit",
      headers: { Accept: "text/html" },
    });
    if (!response.ok) throw new Error(`X ответил ${response.status}.`);

    const html = await response.text();
    const fetchedDocument = new DOMParser().parseFromString(html, "text/html");
    const expectedPath = normalizeStatusPath(postKey);
    const article = [...fetchedDocument.querySelectorAll("article")].find((candidate) => (
      [...candidate.querySelectorAll('a[href*="/status/"]')]
        .some((link) => normalizeStatusPath(link.getAttribute("href")) === expectedPath)
    ));
    const root = article || fetchedDocument.body;
    const candidates = [...root.querySelectorAll('[dir="auto"]')]
      .map((element) => normalizePlainText(element.textContent))
      .filter((text) => text.length > truncatedBase.length + 8)
      .filter((text) => expansionBase(text).startsWith(truncatedBase))
      .sort((left, right) => right.length - left.length);
    if (!candidates[0]) throw new Error("X не отдал полный текст поста.");
    return candidates[0];
  }

  function normalizeStatusPath(value) {
    try {
      return new URL(value, location.origin).pathname.replace(/\/$/u, "");
    } catch {
      return "";
    }
  }

  function buildTextRequest(value) {
    const plainText = normalizePlainText(value);
    const tokens = [];
    return {
      plainText,
      html: `<div>${serializeText(plainText, tokens)}</div>`,
      tokens,
    };
  }

  function trimExpansionPrefetches() {
    while (expansionPrefetches.size > EXPANSION_PREFETCH_LIMIT) {
      const oldestKey = expansionPrefetches.keys().next().value;
      const entry = expansionPrefetches.get(oldestKey);
      if (["queued", "loading"].includes(entry?.status)) break;
      expansionPrefetches.delete(oldestKey);
    }
  }

  function buildRequest(element) {
    const tokens = [];
    const html = [...element.childNodes].map((node) => serializeNode(node, tokens)).join("");
    return {
      plainText: normalizePlainText(element.innerText || element.textContent),
      html: `<div>${html}</div>`,
      tokens,
    };
  }

  function serializeNode(node, tokens) {
    if (node.nodeType === Node.TEXT_NODE) {
      return serializeText(node.nodeValue || "", tokens);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const tag = node.tagName.toLowerCase();
    if (tag === "br") return "<br/>";

    if (tag === "a" || tag === "img") {
      return serializeProtectedElement(node, tokens);
    }

    return [...node.childNodes].map((child) => serializeNode(child, tokens)).join("");
  }

  function serializeText(value, tokens) {
    const parts = String(value).split(/((?:https?:\/\/|www\.)\S+|@[\p{L}\p{N}_]+|#[\p{L}\p{N}_]+|\$[A-Z][A-Z0-9_]*)/gu);
    return parts.map((part) => {
      if (!part) return "";
      if (/^(?:https?:\/\/|www\.|@|#|\$[A-Z])/u.test(part)) {
        return serializeProtectedText(part, tokens);
      }
      return escapeHtml(part).replace(/\r\n?|\n/g, "<br/>");
    }).join("");
  }

  function serializeProtectedElement(element, tokens) {
    const id = tokens.length;
    tokens.push({ kind: "element", text: element.textContent || element.getAttribute("alt") || "", node: element.cloneNode(true) });
    return `<span class="notranslate" data-xtr-token="${id}">${escapeHtml(tokens[id].text)}</span>`;
  }

  function serializeProtectedText(value, tokens) {
    const id = tokens.length;
    tokens.push({ kind: "text", text: value });
    return `<span class="notranslate" data-xtr-token="${id}">${escapeHtml(value)}</span>`;
  }

  function scheduleFlush(delay = 90) {
    if (flushTimer !== null || flushInFlight) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushQueue();
    }, delay);
  }

  async function flushQueue() {
    if (!enabled || !queue.length || flushInFlight) return;
    flushInFlight = true;

    const batch = [];
    let characters = 0;
    queue.sort((left, right) => elementPriority(left.element) - elementPriority(right.element));
    while (queue.length && batch.length < BATCH_SIZE) {
      const state = queue.shift();
      if (!state.element.isConnected || state.status !== "queued") continue;
      if (batch.length && characters + state.html.length > BATCH_CHARACTERS) {
        queue.unshift(state);
        break;
      }
      characters += state.html.length;
      state.status = "loading";
      batch.push(state);
    }

    if (!batch.length) {
      flushInFlight = false;
      return;
    }

    try {
      const response = await runtimeMessage({
        type: "TRANSLATE_BATCH",
        items: batch.map((state) => ({
          id: state.requestId,
          html: state.html,
          plainText: state.plainText,
        })),
      });

      if (!response?.ok) {
        batch.forEach((state) => markForRetry(state, response?.retryAfterMs));
        return;
      }

      const byId = new Map((response.results || []).map((result) => [String(result.id), result]));
      batch.forEach((state) => applyTranslation(state, byId.get(state.requestId)));
    } catch (error) {
      console.debug("[X Translator] Перевод временно недоступен:", error);
      batch.forEach((state) => markForRetry(state));
    } finally {
      flushInFlight = false;
      if (queue.length) scheduleFlush(20);
    }
  }

  function markForRetry(state, retryAfterMs = 0) {
    if (!state || ["removed", "superseded", "translated", "skipped"].includes(state.status)) return;
    state.retryCount = (state.retryCount || 0) + 1;
    const backoff = Math.min(RETRY_DELAY * (2 ** (state.retryCount - 1)), MAX_RETRY_DELAY);
    const delay = Math.max(backoff, Number(retryAfterMs || 0));
    state.status = "error";
    state.retryAt = Date.now() + delay;
    showTranslationError(state);
    setTimeout(() => {
      if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
      if (state.view) {
        clearExpansionPending(state.view);
        showExpansionPending(state.view);
      }
      processTarget(state.element);
    }, delay + 25);
  }

  function applyTranslation(state, result) {
    if (!result?.translatedHtml || !state.element.isConnected) {
      markForRetry(state);
      return;
    }
    if (states.get(state.element) !== state) return;
    clearStatePending(state);
    if (languagesMatch(result.detectedLanguage, TARGET_LANGUAGE)) {
      clearExpansionPending(state.view);
      removeStateView(state);
      state.status = "skipped";
      return;
    }

    const fragment = renderTranslation(result.translatedHtml, state.tokens);
    const renderedText = normalizePlainText(fragment.textContent);
    if (!renderedText || renderedText.toLocaleLowerCase("ru") === state.plainText.toLocaleLowerCase("ru")) {
      clearExpansionPending(state.view);
      removeStateView(state);
      state.status = "skipped";
      return;
    }

    const translated = state.element.cloneNode(false);
    stripConflictingAttributes(translated);
    translated.setAttribute("data-xtr-owned", "translation");
    translated.setAttribute("lang", TARGET_LANGUAGE);
    translated.setAttribute("dir", "auto");
    translated.append(fragment);

    if (state.view) {
      const view = state.view;
      clearExpansionPending(view);
      if (view.languageLabel) {
        view.languageLabel.textContent = `Исходный язык: ${displayLanguage(result.detectedLanguage)}`;
      }
      translated.hidden = view.showingOriginal;
      view.translatedElement.replaceWith(translated);
      view.translatedElement = translated;
      view.sourceElement = state.element;
      setOriginalVisible(view, view.showingOriginal);
      state.status = "translated";
      ensureExpansionPrefetch(state);
      return;
    }

    const view = {
      owner: state,
      sourceElement: state.element,
      metaElement: null,
      translatedElement: translated,
      showingOriginal: false,
      expansionElement: null,
    };
    const meta = createMetaRow(result.detectedLanguage, view);
    view.metaElement = meta;
    state.view = view;
    state.element.before(meta);
    state.element.after(translated);
    setOriginalVisible(view, false);
    state.status = "translated";
    ensureExpansionPrefetch(state);
  }

  function renderTranslation(html, tokens) {
    const documentResult = new DOMParser().parseFromString(html, "text/html");
    const root = documentResult.body.firstElementChild || documentResult.body;
    const fragment = document.createDocumentFragment();
    const usedTokens = new Set();
    [...root.childNodes].forEach((node) => appendSafeNode(node, fragment, tokens, usedTokens));
    return fragment;
  }

  function appendSafeNode(source, target, tokens, usedTokens) {
    if (source.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(source.nodeValue || ""));
      return;
    }
    if (source.nodeType !== Node.ELEMENT_NODE) return;

    const tag = source.tagName.toLowerCase();
    if (tag === "br") {
      target.append(document.createElement("br"));
      return;
    }

    if (tag === "span" && source.classList.contains("notranslate")) {
      let tokenId = Number(source.getAttribute("data-xtr-token"));
      if (!Number.isInteger(tokenId) || !tokens[tokenId]) {
        tokenId = tokens.findIndex((token, index) => !usedTokens.has(index) && token.text === source.textContent);
      }
      if (tokenId >= 0 && tokens[tokenId]) {
        usedTokens.add(tokenId);
        const token = tokens[tokenId];
        if (token.kind === "element") {
          const clone = token.node.cloneNode(true);
          stripConflictingAttributes(clone, true);
          target.append(clone);
        } else {
          target.append(document.createTextNode(token.text));
        }
        return;
      }
    }

    [...source.childNodes].forEach((child) => appendSafeNode(child, target, tokens, usedTokens));
  }

  function stripConflictingAttributes(element, deep = false) {
    const nodes = deep ? [element, ...element.querySelectorAll("*")] : [element];
    nodes.forEach((node) => {
      node.removeAttribute("id");
      node.removeAttribute("data-testid");
      node.removeAttribute("aria-describedby");
      node.removeAttribute("data-xtr-original-hidden");
    });
  }

  function createMetaRow(languageCode, view) {
    const row = document.createElement("div");
    row.dir = "ltr";
    row.className = "css-146c3p1 r-bcqeeo r-qvutc0 r-37j5jr r-n6v787 r-1cwl3u0 r-16dba41 r-9aw3ui r-1ceczpf r-1h8ys4a r-fdjqy7 r-1mnahxq";
    row.style.color = "rgb(113, 118, 123)";

    const icon = createSourceIcon();

    const label = document.createElement("span");
    label.className = "css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3 r-ad9o1y r-wizibn";
    const languageLabel = document.createElement("span");
    languageLabel.className = "css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3";
    languageLabel.textContent = `Исходный язык: ${displayLanguage(languageCode)}`;
    label.append(languageLabel);

    const button = document.createElement("button");
    button.setAttribute("aria-label", "Показать оригинал");
    button.setAttribute("role", "button");
    button.className = "css-175oi2r r-xoduu5 r-sdzlij r-1phboty r-rs99b7 r-lrvibr r-1ut7uwi r-ad9o1y r-12sks89 r-1y7e96w r-n7gxbd r-1loqt21 r-o7ynqc r-6416eg r-1ny4l3l";
    button.setAttribute("type", "button");
    button.style.backgroundColor = "rgba(0, 0, 0, 0)";
    button.style.borderColor = "rgba(0, 0, 0, 0)";

    const buttonContent = document.createElement("span");
    buttonContent.className = "css-1jxf684 r-qvutc0 r-poiln3 r-q4m81j r-16dba41 r-1awozwy r-6koalj r-18u37iz r-16y2uox r-bcqeeo r-1777fci";
    buttonContent.style.color = "rgb(29, 155, 240)";
    const buttonInner = document.createElement("div");
    buttonInner.className = "css-175oi2r r-xoduu5";
    const buttonClip = document.createElement("span");
    buttonClip.className = "css-1jxf684 r-dnmrzs r-1udh08x r-1udbk01 r-3s2u2q r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3 r-n6v787 r-1cwl3u0";
    const buttonLabel = document.createElement("span");
    buttonLabel.className = "css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3";
    buttonLabel.textContent = "Показать оригинал";
    buttonClip.append(buttonLabel);
    buttonInner.append(buttonClip);
    buttonContent.append(buttonInner);
    button.append(buttonContent);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setOriginalVisible(view, !view.showingOriginal);
    });

    view.languageLabel = languageLabel;
    view.buttonElement = button;
    view.buttonLabel = buttonLabel;
    row.append(icon, label, button);
    return row;
  }

  function createSourceIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(namespace, "svg");
    icon.setAttribute("class", "r-4qtqp9 r-yyyyoo r-1xvli5t r-dnmrzs r-bnwqim r-lrvibr r-1bwzh9t r-ad9o1y");
    icon.setAttribute("viewBox", "0 0 33 32");
    icon.setAttribute("aria-hidden", "true");
    const group = document.createElementNS(namespace, "g");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", "M12.745 20.54l10.97-8.19c.539-.4 1.307-.244 1.564.38 1.349 3.288.746 7.241-1.938 9.955-2.683 2.714-6.417 3.31-9.83 1.954l-3.728 1.745c5.347 3.697 11.84 2.782 15.898-1.324 3.219-3.255 4.216-7.692 3.284-11.693l.008.009c-1.351-5.878.332-8.227 3.782-13.031L33 0l-4.54 4.59v-.014L12.743 20.544m-2.263 1.987c-3.837-3.707-3.175-9.446.1-12.755 2.42-2.449 6.388-3.448 9.852-1.979l3.72-1.737c-.67-.49-1.53-1.017-2.515-1.387-4.455-1.854-9.789-.931-13.41 2.728-3.483 3.523-4.579 8.94-2.697 13.561 1.405 3.454-.899 5.898-3.22 8.364C1.49 30.2.666 31.074 0 32l10.478-9.466");
    group.append(path);
    icon.append(group);
    return icon;
  }

  function scheduleInitialLoading(state) {
    if (state.view || state.pendingElement || state.loadingTimer !== null) return;
    const delay = state.retryCount > 0 ? 0 : INITIAL_LOADING_DELAY;
    state.loadingTimer = setTimeout(() => {
      state.loadingTimer = null;
      if (
        !enabled
        || !state.element.isConnected
        || states.get(state.element) !== state
        || !["queued", "loading"].includes(state.status)
      ) return;
      showInitialLoading(state);
    }, delay);
  }

  function showInitialLoading(state) {
    if (state.view || state.pendingElement) return;
    const row = createMetaStatusRow();
    const text = row.querySelector('[data-xtr-status-text]');
    text.textContent = "Перевожу…";
    text.classList.add("xtr-shimmer");
    state.element.before(row);
    state.pendingElement = row;
  }

  function createMetaStatusRow() {
    const row = document.createElement("div");
    row.dir = "ltr";
    row.setAttribute("data-xtr-owned", "status");
    row.className = "css-146c3p1 r-bcqeeo r-qvutc0 r-37j5jr r-n6v787 r-1cwl3u0 r-16dba41 r-9aw3ui r-1ceczpf r-1h8ys4a r-fdjqy7 r-1mnahxq";
    row.style.color = "rgb(113, 118, 123)";

    const label = document.createElement("span");
    label.className = "css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3 r-ad9o1y r-wizibn";
    const text = document.createElement("span");
    text.setAttribute("data-xtr-status-text", "");
    text.className = "css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3";
    label.append(text);
    row.append(createSourceIcon(), label);
    return row;
  }

  function showExpansionPending(view) {
    if (!view || view.expansionElement) return;
    const indicator = document.createElement("div");
    indicator.dir = "ltr";
    indicator.setAttribute("data-xtr-owned", "expansion-status");
    indicator.className = "css-146c3p1 r-bcqeeo r-qvutc0 r-37j5jr r-1cwl3u0 r-16dba41";
    indicator.style.color = "rgb(113, 118, 123)";
    indicator.textContent = "Перевожу продолжение…";
    indicator.classList.add("xtr-shimmer");
    indicator.hidden = view.showingOriginal;
    view.translatedElement.after(indicator);
    view.expansionElement = indicator;
  }

  function clearExpansionPending(view) {
    view?.expansionElement?.remove();
    if (view) view.expansionElement = null;
  }

  function showTranslationError(state) {
    clearStatePending(state);

    if (state.view) {
      clearExpansionPending(state.view);
      const indicator = document.createElement("div");
      indicator.dir = "ltr";
      indicator.setAttribute("data-xtr-owned", "expansion-status");
      indicator.className = "css-146c3p1 r-bcqeeo r-qvutc0 r-37j5jr r-1cwl3u0 r-16dba41";
      indicator.style.color = "rgb(113, 118, 123)";
      appendRetryContent(indicator, state);
      indicator.hidden = state.view.showingOriginal;
      state.view.translatedElement.after(indicator);
      state.view.expansionElement = indicator;
      return;
    }

    const row = createMetaStatusRow();
    const text = row.querySelector('[data-xtr-status-text]');
    const label = text.parentElement;
    text.remove();
    appendRetryContent(label, state);
    state.element.before(row);
    state.pendingElement = row;
  }

  function appendRetryContent(container, state) {
    container.append(document.createTextNode("Не удалось перевести · "));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "xtr-inline-action";
    retry.textContent = "Повторить";
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
      state.retryAt = 0;
      state.status = "error";
      if (state.view) {
        clearExpansionPending(state.view);
        showExpansionPending(state.view);
      }
      processTarget(state.element);
    });
    container.append(retry);
  }

  function clearStatePending(state) {
    if (!state) return;
    if (state.loadingTimer !== null) {
      clearTimeout(state.loadingTimer);
      state.loadingTimer = null;
    }
    state.pendingElement?.remove();
    state.pendingElement = null;
  }

  function setOriginalVisible(view, visible) {
    if (!view?.sourceElement || !view.metaElement || !view.translatedElement) return;
    view.showingOriginal = Boolean(visible);
    const text = visible ? "Показать перевод" : "Показать оригинал";
    if (visible) {
      view.sourceElement.removeAttribute("data-xtr-original-hidden");
      view.translatedElement.hidden = true;
    } else {
      view.sourceElement.setAttribute("data-xtr-original-hidden", "true");
      view.translatedElement.hidden = false;
    }
    if (view.expansionElement) view.expansionElement.hidden = visible;
    if (view.buttonLabel) view.buttonLabel.textContent = text;
    if (view.buttonElement) view.buttonElement.setAttribute("aria-label", text);
  }

  function displayLanguage(code) {
    if (!code) return "не определён";
    try {
      const value = new Intl.DisplayNames(["ru"], { type: "language" }).of(code);
      return value ? value.toLocaleLowerCase("ru") : code;
    } catch {
      return code.toLocaleLowerCase("ru");
    }
  }

  function cleanupState(state) {
    clearStatePending(state);
    removeStateView(state);
    state.status = "removed";
    trackedStates.delete(state);
  }

  function removeStateView(state) {
    const view = state.view;
    if (!view || view.owner !== state) return;
    clearExpansionPending(view);
    view.metaElement?.remove();
    view.translatedElement?.remove();
    view.sourceElement?.removeAttribute?.("data-xtr-original-hidden");
    state.view = null;
  }

  function removeAllTranslations() {
    queue.splice(0, queue.length);
    expansionPrefetchQueue.splice(0, expansionPrefetchQueue.length);
    expansionPrefetches.clear();
    for (const state of [...trackedStates]) {
      cleanupState(state);
      states.delete(state.element);
    }
  }

  function sweepDetachedStates() {
    for (const state of [...trackedStates]) {
      if (!state.element.isConnected) cleanupState(state);
    }
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }
})();
