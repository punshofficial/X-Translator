(function xTranslatorContentScript() {
  "use strict";

  const {
    canReuseTranslationView,
    escapeHtml,
    languagesMatch,
    normalizePlainText,
  } = XTranslatorCore;

  const PRIMARY_SELECTOR = '[data-testid="tweetText"]';
  const PUBLIC_ARTICLE_SELECTOR = 'article[data-tweet-id][itemtype="https://schema.org/SocialMediaPosting"]';
  const OWNED_SELECTOR = "[data-xtr-owned]";
  const NATIVE_TRANSLATION_HIDDEN_ATTR = "data-xtr-native-translation-hidden";
  const NATIVE_EXPANSION_HIDDEN_ATTR = "data-xtr-native-expansion-hidden";
  const EARLY_GUARD_ATTR = "data-xtr-early-guard";
  const SOURCE_READY_ATTR = "data-xtr-source-ready";
  const EXPAND_CONTROL_ATTR = "data-xtr-expand-control";
  const FULL_CONTENT_ATTR = "data-xtr-full-content";
  const SOURCE_ICON_PATH = "M12.745 20.54l10.97-8.19c.539-.4 1.307-.244 1.564.38 1.349 3.288.746 7.241-1.938 9.955-2.683 2.714-6.417 3.31-9.83 1.954l-3.728 1.745c5.347 3.697 11.84 2.782 15.898-1.324 3.219-3.255 4.216-7.692 3.284-11.693l.008.009c-1.351-5.878.332-8.227 3.782-13.031L33 0l-4.54 4.59v-.014L12.743 20.544m-2.263 1.987c-3.837-3.707-3.175-9.446.1-12.755 2.42-2.449 6.388-3.448 9.852-1.979l3.72-1.737c-.67-.49-1.53-1.017-2.515-1.387-4.455-1.854-9.789-.931-13.41 2.728-3.483 3.523-4.579 8.94-2.697 13.561 1.405 3.454-.899 5.898-3.22 8.364C1.49 30.2.666 31.074 0 32l10.478-9.466";
  const TARGET_LANGUAGE = "ru";
  const TRANSLATION_CONCURRENCY = 2;
  const RETRY_DELAY = 5_000;
  const MAX_RETRY_DELAY = 30_000;
  const EXPANSION_PREFETCH_LIMIT = 40;
  const VIEWPORT_MARGIN_FACTOR = 0.75;
  const INITIAL_LOADING_DELAY = 350;
  const EARLY_GUARD_TIMEOUT = INITIAL_LOADING_DELAY + 100;
  // Blur Text by Animshelf: https://animshelf.dev/text-animations/blur-text
  const BLUR_TEXT_DURATION = 700;
  const BLUR_TEXT_STAGGER = 55;
  const BLUR_TEXT_AMOUNT = 18;
  const BLUR_TEXT_OFFSET = 10;
  const BLUR_TEXT_MAX_DURATION = 6_000;
  const BLUR_TEXT_EASING = "cubic-bezier(.22,.61,.36,1)";

  const states = new WeakMap();
  const trackedStates = new Set();
  const queue = [];
  let enabled = true;
  let flushTimer = null;
  let activeTranslations = 0;
  let scanTimer = null;
  let earlyGuardTimer = null;
  let requestSequence = 0;
  const expansionPrefetches = new Map();
  const expansionControls = new WeakMap();
  const nativeExpansionControls = new WeakMap();
  const revealAnimations = new WeakMap();
  const presentedTranslations = new Set();
  const releasedSources = new Set();
  const expandedPostTranslations = new Set();

  start();

  async function start() {
    const settings = await storageGet({ enabled: true });
    enabled = settings.enabled !== false;
    setEarlyGuard(enabled);
    observePage();
    scanDocument();

    document.addEventListener("click", handleExpansionClick, true);
    document.addEventListener("keydown", handleExpansionKeydown, true);
    window.addEventListener("pageshow", scheduleScan, true);
    window.addEventListener("popstate", scheduleScan, true);
    window.addEventListener("hashchange", scheduleScan, true);
    document.addEventListener("scroll", () => scheduleScan(40), {
      capture: true,
      passive: true,
    });
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
        urgent ||= mutation.type === "childList" && (
          [...mutation.removedNodes].some((node) => (
            node.nodeType === Node.ELEMENT_NODE
            && (node.matches?.(OWNED_SELECTOR) || node.querySelector?.(OWNED_SELECTOR))
          ))
          || [...mutation.addedNodes].some((node) => (
            node.nodeType === Node.ELEMENT_NODE
            && (node.matches?.(PRIMARY_SELECTOR) || node.querySelector?.(PRIMARY_SELECTOR))
          ))
        );
      }
      if (urgent) {
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
          setEarlyGuard(false);
          removeAllTranslations();
          return;
        }
        document.querySelectorAll(`[${SOURCE_READY_ATTR}]`)
          .forEach((element) => element.removeAttribute(SOURCE_READY_ATTR));
        setEarlyGuard(true);
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
    if (!control || !isExpansionLabel(control.textContent)) return;

    const translatedView = expansionControls.get(control);
    if (translatedView) {
      event.preventDefault();
      event.stopImmediatePropagation();
      expandTranslatedView(translatedView);
      return;
    }

    const article = control.closest('article[data-testid="tweet"]') || control.closest("article");
    const source = article?.querySelector(PRIMARY_SELECTOR);
    const state = nativeExpansionControls.get(control) || (source ? states.get(source) : null);
    if (state) rememberTranslationExpanded(state);
    const prepared = state?.postKey ? expansionPrefetches.get(state.postKey) : null;
    if (state?.view && prepared?.status !== "ready") showExpansionPending(state.view);

    setTimeout(() => {
      if (enabled) scanDocument();
    }, 0);
    setTimeout(() => {
      if (enabled) scanDocument();
    }, 60);
  }

  function handleExpansionKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const control = event.target?.closest?.(`[${EXPAND_CONTROL_ATTR}]`);
    const view = control ? expansionControls.get(control) : null;
    if (!view) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    expandTranslatedView(view);
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
      .filter((element) => states.has(element) || isNearViewport(element))
      .map((element) => ({ element, priority: elementPriority(element) }))
      .sort((left, right) => left.priority - right.priority)
      .forEach(({ element }) => processTarget(element));
  }

  function isNearViewport(element) {
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 800;
    const margin = viewportHeight * VIEWPORT_MARGIN_FACTOR;
    return rect.bottom >= -margin && rect.top <= viewportHeight + margin;
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
    if (!request.plainText || request.plainText.length < 2) {
      releaseSource(element);
      return;
    }

    // Do not inherit <html lang>: on public X pages it describes the interface,
    // not the post. When the text container has no own language, let Bing
    // detect it from the post body.
    const sourceLanguage = element.getAttribute("lang") || "";
    if (languagesMatch(sourceLanguage, TARGET_LANGUAGE)) {
      releaseSource(element);
      return;
    }

    const fingerprint = `${request.plainText}\u0000${request.html}`;
    const previous = states.get(element);
    if (previous && previous.fingerprint === fingerprint) {
      if (["queued", "loading", "translated"].includes(previous.status)) {
        if (previous.view) ensureViewMounted(previous);
        if (
          !previous.view
          && previous.pendingElement
          && !previous.pendingElement.isConnected
        ) {
          previous.pendingElement = null;
          showInitialLoading(previous);
        }
        syncNativeTranslationRow(previous);
        return;
      }
      if (previous.status === "skipped") {
        releaseSource(element);
        return;
      }
      if (previous.status === "error" && Date.now() < previous.retryAt) return;
    }

    const location = locateTarget(element);
    const expansionControl = findPostExpansionControl(element, location.containerElement);
    const isExpandable = Boolean(expansionControl) || isExpandableText(request.plainText);
    const reusableState = previous
      || findAdjacentViewState(element)
      || findContainerState(location, request.plainText);
    const reusableView = reusableState?.view || null;
    const reusablePendingElement = reusableState?.pendingElement?.isConnected
      ? reusableState.pendingElement
      : null;
    const reusableLoadingDeadline = reusableState?.loadingDeadline || 0;
    const canReuseCompletedTranslation = Boolean(
      reusableState?.status === "translated"
      && reusableState.fingerprint === fingerprint
      && reusableView?.translatedElement,
    );
    const nativeTranslationRows = reusableState?.nativeTranslationRows || new Set();
    const isExpansionReplacement = Boolean(
      reusableState
      && reusableState.isExpandable
      && !isExpandable
      && request.plainText.length > expansionBase(reusableState.plainText).length + 8,
    );

    if (reusableState) {
      if (reusableState.loadingTimer !== null) clearTimeout(reusableState.loadingTimer);
      reusableState.loadingTimer = null;
      reusableState.loadingDeadline = 0;
      reusableState.pendingElement = null;
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
      loadingDeadline: reusableLoadingDeadline,
      pendingElement: reusablePendingElement,
      view: reusableView,
      containerElement: location.containerElement,
      targetIndex: location.targetIndex,
      postKey: location.postKey,
      isExpandable,
      sourceExpansionControl: expansionControl,
      collapsedMetrics: isExpandable
        ? measureCollapsedSource(element, expansionControl)
        : null,
      translationRequest: null,
      translationPromise: null,
      errorKind: "",
      expandTranslationOnApply: isExpansionReplacement,
      nativeTranslationRows,
    };
    if (releasedSources.has(translationContentKey(state))) {
      releaseSource(element);
    } else {
      holdSource(element);
    }
    if (state.pendingElement && element.previousElementSibling !== state.pendingElement) {
      element.before(state.pendingElement);
    }
    if (reusableView) {
      location.containerElement
        ?.querySelectorAll?.('[data-xtr-owned="expansion-status"]')
        .forEach((indicator) => {
          if (indicator !== reusableView.expansionElement) indicator.remove();
        });
      reusableView.owner = state;
      reusableView.sourceElement = element;
      reusableView.sourceExpansionControl = expansionControl;
      reusableView.nativeTranslationRows = nativeTranslationRows;
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
    if (expansionControl) nativeExpansionControls.set(expansionControl, state);
    trackedStates.add(state);
    syncNativeTranslationRow(state);

    if (canReuseCompletedTranslation) {
      state.status = "translated";
      ensureViewMounted(state);
      return;
    }

    const prefetched = matchingExpansionPrefetch(state);
    if (prefetched?.status === "ready") {
      applyTranslation(state, prefetched.result, prefetched.request, {
        collapsible: state.isExpandable && !state.expandTranslationOnApply,
        expanded: isTranslationExpanded(state),
      });
      return;
    }

    if (state.isExpandable) {
      if (state.postKey) {
        const entry = ensureExpansionPrefetch(state);
        waitForExpansionPrefetch(state, entry);
      } else {
        markForRetry(state, 0, "full-text");
      }
      return;
    }

    if (isExpansionReplacement) {
      const pending = expansionPrefetches.get(state.postKey);
      if (pending && ["fetching", "queued", "loading"].includes(pending.status)) {
        showExpansionPending(state.view);
        waitForExpansionPrefetch(state, pending);
        return;
      }
    }

    enqueueState(state);
  }

  function enqueueState(state, request = state) {
    if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
    if (state.translationPromise) return;
    state.translationRequest = request;
    state.status = "queued";
    scheduleInitialLoading(state);
    state.translationPromise = requestTranslation({
      id: state.requestId,
      html: request.html,
      plainText: request.plainText,
    }, translationPriority(state), () => {
      if (states.get(state.element) === state && state.status === "queued") {
        state.status = "loading";
      }
    }).then((result) => {
      state.translationPromise = null;
      if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
      applyTranslation(state, result, request);
    }).catch((error) => {
      state.translationPromise = null;
      if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
      console.debug("[X Translator] Перевод временно недоступен:", error);
      markForRetry(state, error?.retryAfterMs, error?.xtrKind || "translation");
    });
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

  function findContainerState(location, plainText) {
    if (!location.containerElement && !location.postKey) return null;
    let best = null;
    for (const state of trackedStates) {
      if (["removed", "superseded", "skipped"].includes(state.status)) continue;
      const sameContainer = state.containerElement === location.containerElement;
      const samePost = location.postKey && state.postKey === location.postKey;
      if (!canReuseTranslationView({
        sameContainer,
        samePost,
        sourceConnected: state.element.isConnected,
      })) continue;
      if (state.targetIndex !== location.targetIndex) continue;
      if (!textsRepresentSamePost(state.plainText, plainText)) continue;
      if (!best || Number(state.requestId) > Number(best.requestId)) best = state;
    }
    return best;
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

  function isExpansionLabel(value) {
    return /^(?:Показать\s+(?:ещё|еще|больше)|Show\s+more)$/iu
      .test(normalizePlainText(value));
  }

  function matchingExpansionPrefetch(state) {
    if (!state.postKey) return null;
    const entry = expansionPrefetches.get(state.postKey);
    return entry?.request?.plainText === state.plainText ? entry : null;
  }

  function waitForExpansionPrefetch(state, entry) {
    state.status = "loading";
    scheduleInitialLoading(state);
    entry.priority = Math.min(entry.priority, translationPriority(state));

    entry.promise.then((resolved) => {
      if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
      if (resolved.status === "ready" && resolved.request && resolved.result) {
        applyTranslation(state, resolved.result, resolved.request, {
          collapsible: state.isExpandable && !state.expandTranslationOnApply,
          expanded: isTranslationExpanded(state),
        });
        return;
      }
      markForRetry(
        state,
        resolved.error?.retryAfterMs,
        resolved.errorKind || "full-text",
      );
    });
  }

  function ensureExpansionPrefetch(state) {
    const existing = expansionPrefetches.get(state.postKey);
    if (existing && existing.status !== "error") return existing;
    if (existing) expansionPrefetches.delete(state.postKey);

    const entry = {
      postKey: state.postKey,
      truncatedBase: expansionBase(state.plainText),
      status: "fetching",
      priority: translationPriority(state),
      request: null,
      result: null,
      error: null,
      errorKind: "",
      promise: null,
    };
    expansionPrefetches.set(entry.postKey, entry);
    entry.promise = prepareExpansionPrefetch(entry);
    trimExpansionPrefetches();
    return entry;
  }

  async function prepareExpansionPrefetch(entry) {
    try {
      try {
        entry.request = await fetchFullPostRequest(entry.postKey, entry.truncatedBase);
      } catch (error) {
        error.xtrKind = "full-text";
        throw error;
      }

      entry.status = "queued";
      entry.result = await requestTranslation({
        id: `full:${normalizeStatusPath(entry.postKey)}`,
        html: entry.request.html,
        plainText: entry.request.plainText,
      }, () => entry.priority, () => {
        entry.status = "loading";
      });
      entry.status = "ready";
    } catch (error) {
      entry.status = "error";
      entry.error = error;
      entry.errorKind = error?.xtrKind || "translation";
      console.debug("[X Translator] Не удалось подготовить полный пост:", error);
    } finally {
      trimExpansionPrefetches();
    }
    return entry;
  }

  async function fetchFullPostRequest(postKey, truncatedBase) {
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
      .map((element) => ({ element, text: normalizePlainText(element.textContent) }))
      .filter(({ text }) => text.length > truncatedBase.length + 8)
      .filter(({ text }) => expansionBase(text).startsWith(truncatedBase))
      .sort((left, right) => right.text.length - left.text.length);
    if (!candidates[0]) throw new Error("X не отдал полный текст поста.");
    return buildRequest(candidates[0].element, true);
  }

  function normalizeStatusPath(value) {
    try {
      return new URL(value, location.origin).pathname.replace(/\/$/u, "");
    } catch {
      return "";
    }
  }

  function trimExpansionPrefetches() {
    while (expansionPrefetches.size > EXPANSION_PREFETCH_LIMIT) {
      const oldestKey = expansionPrefetches.keys().next().value;
      const entry = expansionPrefetches.get(oldestKey);
      if (["fetching", "queued", "loading"].includes(entry?.status)) break;
      expansionPrefetches.delete(oldestKey);
    }
  }

  function buildRequest(element, preferTextContent = false) {
    const tokens = [];
    const html = [...element.childNodes].map((node) => serializeNode(node, tokens)).join("");
    return {
      plainText: normalizePlainText(
        preferTextContent ? element.textContent : element.innerText || element.textContent,
      ),
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

  function requestTranslation(item, priority, onStart) {
    return new Promise((resolve, reject) => {
      queue.push({ item, priority, onStart, resolve, reject });
      scheduleFlush();
    });
  }

  function scheduleFlush(delay = 0) {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushQueue();
    }, delay);
  }

  function flushQueue() {
    if (!enabled) return;
    queue.sort((left, right) => translationJobPriority(left) - translationJobPriority(right));
    const concurrency = hasPrimaryFullPostFetch()
      ? Math.max(1, TRANSLATION_CONCURRENCY - 1)
      : TRANSLATION_CONCURRENCY;

    while (queue.length && activeTranslations < concurrency) {
      const job = queue.shift();
      activeTranslations += 1;
      job.onStart?.();

      runtimeMessage({
        type: "TRANSLATE_BATCH",
        items: [job.item],
      }).then((response) => {
        const result = response?.ok ? response.results?.[0] : null;
        if (!result?.translatedHtml) {
          const error = new Error(response?.error || "Переводчик не вернул результат.");
          error.retryAfterMs = Number(response?.retryAfterMs || 0);
          error.xtrKind = "translation";
          throw error;
        }
        job.resolve(result);
      }).catch(job.reject).finally(() => {
        activeTranslations -= 1;
        if (queue.length) scheduleFlush();
      });
    }
  }

  function hasPrimaryFullPostFetch() {
    return [...expansionPrefetches.values()].some((entry) => (
      entry.status === "fetching" && entry.priority < -1_000
    ));
  }

  function translationJobPriority(job) {
    const value = typeof job.priority === "function" ? job.priority() : job.priority;
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  }

  function translationPriority(state) {
    let priority = elementPriority(state.element);
    const postPath = normalizeStatusPath(state.postKey);
    const currentPath = normalizeStatusPath(location.href);
    if (postPath && postPath === currentPath) priority -= 10_000;
    if (state.targetIndex > 0) priority += state.targetIndex * 250;
    return priority;
  }

  function markForRetry(state, retryAfterMs = 0, errorKind = "translation") {
    if (!state || ["removed", "superseded", "translated", "skipped"].includes(state.status)) return;
    state.retryCount = (state.retryCount || 0) + 1;
    const backoff = Math.min(RETRY_DELAY * (2 ** (state.retryCount - 1)), MAX_RETRY_DELAY);
    const delay = Math.max(backoff, Number(retryAfterMs || 0));
    state.status = "error";
    state.errorKind = errorKind;
    state.retryAt = Date.now() + delay;
    if (!state.view) restoreNativeTranslationRows(state);
    showTranslationError(state);
    setTimeout(() => {
      if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
      resetFailedExpansion(state);
      if (state.view) {
        clearExpansionPending(state.view);
        showExpansionPending(state.view);
      }
      processTarget(state.element);
    }, delay + 25);
  }

  function applyTranslation(state, result, request = state, options = {}) {
    if (!result?.translatedHtml || !state.element.isConnected) {
      markForRetry(state);
      return;
    }
    if (states.get(state.element) !== state) return;
    clearStatePending(state);
    if (languagesMatch(result.detectedLanguage, TARGET_LANGUAGE)) {
      clearExpansionPending(state.view);
      releaseSource(state.element);
      removeStateView(state);
      state.status = "skipped";
      return;
    }

    state.translationPlainText = request.plainText;
    const fragment = renderTranslation(result.translatedHtml, request.tokens || []);
    const renderedText = normalizePlainText(fragment.textContent);
    if (!renderedText || renderedText.toLocaleLowerCase("ru") === request.plainText.toLocaleLowerCase("ru")) {
      clearExpansionPending(state.view);
      releaseSource(state.element);
      removeStateView(state);
      state.status = "skipped";
      return;
    }

    const translated = state.element.cloneNode(false);
    stripConflictingAttributes(translated);
    translated.setAttribute("data-xtr-owned", "translation");
    translated.setAttribute("lang", TARGET_LANGUAGE);
    translated.setAttribute("dir", "auto");
    const collapsible = Boolean(options.collapsible && state.collapsedMetrics);
    const initiallyExpanded = !collapsible || Boolean(options.expanded);
    const fullContent = collapsible ? document.createElement("span") : null;
    const expandControl = collapsible ? createTranslatedExpansionControl(state) : null;
    if (fullContent) {
      fullContent.setAttribute(FULL_CONTENT_ATTR, "");
      fullContent.append(fragment);
      translated.append(fullContent, expandControl);
    } else {
      translated.append(fragment);
    }
    const shouldReveal = shouldRevealTranslation(state, result);

    if (state.view) {
      const view = state.view;
      finishTranslationReveal(view.translatedElement);
      clearExpansionPending(view);
      if (view.languageLabel) {
        view.languageLabel.textContent = `Исходный язык: ${displayLanguage(result.detectedLanguage)}`;
      }
      translated.hidden = view.showingOriginal;
      view.translatedElement.replaceWith(translated);
      view.translatedElement = translated;
      view.sourceElement = state.element;
      view.collapsible = collapsible;
      view.expanded = initiallyExpanded;
      view.fullContentElement = fullContent;
      view.expandControl = expandControl;
      view.collapsedHeight = state.collapsedMetrics?.contentHeight || 0;
      view.collapsedTotalHeight = state.collapsedMetrics?.totalHeight || 0;
      view.sourceExpansionControl = state.sourceExpansionControl;
      if (expandControl) expansionControls.set(expandControl, view);
      applyTranslationExpansion(view);
      setOriginalVisible(view, view.showingOriginal);
      if (!view.showingOriginal && shouldReveal) {
        revealTranslation(translated);
      }
      syncNativeTranslationRow(state);
      state.status = "translated";
      return;
    }

    const view = {
      owner: state,
      sourceElement: state.element,
      metaElement: null,
      translatedElement: translated,
      showingOriginal: false,
      expansionElement: null,
      collapsible,
      expanded: initiallyExpanded,
      fullContentElement: fullContent,
      expandControl,
      collapsedHeight: state.collapsedMetrics?.contentHeight || 0,
      collapsedTotalHeight: state.collapsedMetrics?.totalHeight || 0,
      sourceExpansionControl: state.sourceExpansionControl,
      nativeTranslationRows: state.nativeTranslationRows,
    };
    if (expandControl) expansionControls.set(expandControl, view);
    const meta = createMetaRow(result.detectedLanguage, view);
    view.metaElement = meta;
    state.view = view;
    state.element.before(meta);
    state.element.after(translated);
    applyTranslationExpansion(view);
    setOriginalVisible(view, false);
    if (shouldReveal) revealTranslation(translated);
    syncNativeTranslationRow(state);
    state.status = "translated";
  }

  function renderTranslation(html, tokens) {
    const documentResult = new DOMParser().parseFromString(html, "text/html");
    const root = documentResult.body.firstElementChild || documentResult.body;
    const fragment = document.createDocumentFragment();
    const usedTokens = new Set();
    [...root.childNodes].forEach((node) => appendSafeNode(node, fragment, tokens, usedTokens));
    return fragment;
  }

  function findPostExpansionControl(element, container) {
    const direct = findExpansionControl(element);
    if (direct) return direct;

    const parentCandidates = expansionControlCandidates(element.parentElement);
    if (parentCandidates.length) return nearestExpansionControl(element, parentCandidates);
    return nearestExpansionControl(element, expansionControlCandidates(container));
  }

  function expansionControlCandidates(root) {
    if (!root) return [];
    return [...root.querySelectorAll('button, a, [role="button"]')]
      .filter((candidate) => !candidate.closest(OWNED_SELECTOR))
      .filter((candidate) => isExpansionLabel(candidate.textContent));
  }

  function nearestExpansionControl(element, candidates) {
    const targetRect = element.getBoundingClientRect();
    return [...candidates].sort((left, right) => {
      const score = (candidate) => {
        const rect = candidate.getBoundingClientRect();
        const beforePenalty = rect.bottom < targetRect.top ? 10_000 : 0;
        return beforePenalty + Math.abs(rect.top - targetRect.bottom);
      };
      return score(left) - score(right);
    })[0] || null;
  }

  function measureCollapsedSource(element, expansionControl) {
    const style = window.getComputedStyle?.(element);
    const fontSize = Number.parseFloat(style?.fontSize) || 15;
    const lineHeight = Number.parseFloat(style?.lineHeight) || fontSize * 1.25;
    const sourceHeight = element.getBoundingClientRect().height || element.scrollHeight || lineHeight;
    const controlInsideSource = Boolean(expansionControl && element.contains(expansionControl));
    const controlHeight = expansionControl?.getBoundingClientRect().height || lineHeight;
    return {
      contentHeight: controlInsideSource
        ? Math.max(lineHeight, sourceHeight - controlHeight)
        : sourceHeight,
      totalHeight: controlInsideSource ? sourceHeight : sourceHeight + controlHeight,
      control: expansionControl?.cloneNode(true) || null,
    };
  }

  function findExpansionControl(element) {
    return [...element.querySelectorAll('button, a, [role="button"]')]
      .find((candidate) => isExpansionLabel(candidate.textContent)) || null;
  }

  function createTranslatedExpansionControl(state) {
    const control = state.collapsedMetrics?.control?.cloneNode(true)
      || document.createElement("button");
    stripConflictingAttributes(control, true);
    control.setAttribute(EXPAND_CONTROL_ATTR, "");
    control.setAttribute("data-xtr-owned", "expand-control");
    control.setAttribute("role", "button");
    control.setAttribute("tabindex", "0");
    control.removeAttribute("href");
    control.removeAttribute("target");
    if (control.tagName === "BUTTON") control.type = "button";
    if (!normalizePlainText(control.textContent)) control.textContent = "Показать ещё";
    return control;
  }

  function applyTranslationExpansion(view) {
    const content = view?.fullContentElement;
    const control = view?.expandControl;
    if (!view?.collapsible || !content || !control) return;

    if (view.expanded) {
      content.style.removeProperty("max-height");
      content.style.removeProperty("overflow");
      view.translatedElement.style.removeProperty("height");
      view.translatedElement.style.removeProperty("overflow");
      control.hidden = true;
      view.translatedElement.removeAttribute("data-xtr-collapsed");
      return;
    }

    content.style.maxHeight = `${Math.max(1, view.collapsedHeight)}px`;
    content.style.overflow = "hidden";
    view.translatedElement.style.height = `${Math.max(1, view.collapsedTotalHeight)}px`;
    view.translatedElement.style.overflow = "hidden";
    control.hidden = false;
    view.translatedElement.setAttribute("data-xtr-collapsed", "true");
  }

  function translationExpansionKey(state) {
    const postPath = normalizeStatusPath(state?.postKey);
    return postPath ? `${postPath}\u0000${state?.targetIndex ?? -1}` : "";
  }

  function isTranslationExpanded(state) {
    const key = translationExpansionKey(state);
    return Boolean(key && expandedPostTranslations.has(key));
  }

  function rememberTranslationExpanded(state) {
    const key = translationExpansionKey(state);
    if (!key) return;
    expandedPostTranslations.add(key);
    while (expandedPostTranslations.size > 500) {
      expandedPostTranslations.delete(expandedPostTranslations.values().next().value);
    }
  }

  function expandTranslatedView(view) {
    if (!view?.collapsible || view.expanded || !view.translatedElement?.isConnected) return;
    finishTranslationReveal(view.translatedElement);

    const content = view.fullContentElement;
    const boundary = content.getBoundingClientRect().top + content.clientHeight - 0.5;
    const continuation = tokenizeTranslationWords(view.translatedElement)
      .filter((token) => content.contains(token))
      .filter((token) => token.getBoundingClientRect().top >= boundary - 1);

    rememberTranslationExpanded(view.owner);
    view.expanded = true;
    revealTranslation(view.translatedElement, {
      tokens: continuation,
      beforeAnimate: () => applyTranslationExpansion(view),
    });
  }

  function revealTranslation(element, options = {}) {
    finishTranslationReveal(element);
    const beforeAnimate = options.beforeAnimate;
    if (
      !element?.isConnected
      || element.hidden
      || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    ) {
      beforeAnimate?.();
      return;
    }

    const tokens = options.tokens || tokenizeTranslationWords(element);
    if (!tokens.length) {
      beforeAnimate?.();
      return;
    }
    const stagger = tokens.length > 1
      ? Math.min(
        BLUR_TEXT_STAGGER,
        (BLUR_TEXT_MAX_DURATION - BLUR_TEXT_DURATION) / (tokens.length - 1),
      )
      : 0;
    const originalStyles = new Map(tokens.map((token) => [token, {
      filter: token.style.getPropertyValue("filter"),
      filterPriority: token.style.getPropertyPriority("filter"),
      opacity: token.style.getPropertyValue("opacity"),
      opacityPriority: token.style.getPropertyPriority("opacity"),
      transform: token.style.getPropertyValue("transform"),
      transformPriority: token.style.getPropertyPriority("transform"),
    }]));

    tokens.forEach((token) => {
      token.style.opacity = "0";
      token.style.filter = `blur(${BLUR_TEXT_AMOUNT}px)`;
      token.style.transform = `translateY(${BLUR_TEXT_OFFSET}px)`;
    });
    beforeAnimate?.();
    void element.offsetWidth;
    element.setAttribute("data-xtr-reveal", "blur-text");

    const animations = tokens.map((token, index) => token.animate(
      [
        {
          opacity: 0,
          filter: `blur(${BLUR_TEXT_AMOUNT}px)`,
          transform: `translateY(${BLUR_TEXT_OFFSET}px)`,
        },
        { opacity: 1, filter: "blur(0px)", transform: "translateY(0)" },
      ],
      {
        duration: BLUR_TEXT_DURATION,
        delay: index * stagger,
        easing: BLUR_TEXT_EASING,
        fill: "forwards",
      },
    ));
    const active = { animations, originalStyles, tokens, settleFrame: null };
    revealAnimations.set(element, active);

    Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
      .then(() => {
        if (revealAnimations.get(element) !== active) return;
        active.settleFrame = requestAnimationFrame(() => {
          active.settleFrame = requestAnimationFrame(() => completeTranslationReveal(element));
        });
      });
  }

  function tokenizeTranslationWords(element) {
    const textNodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (
        /\S/u.test(node.nodeValue || "")
        && !node.parentElement?.closest?.("[data-xtr-blur-token]")
        && !node.parentElement?.closest?.(`[${EXPAND_CONTROL_ATTR}]`)
      ) {
        textNodes.push(node);
      }
    }

    const tokens = [];
    for (const textNode of textNodes) {
      const fragment = document.createDocumentFragment();
      for (const part of (textNode.nodeValue || "").split(/(\s+)/u)) {
        if (!part) continue;
        if (/^\s+$/u.test(part)) {
          fragment.append(document.createTextNode(part));
          continue;
        }
        const token = document.createElement("span");
        token.setAttribute("data-xtr-blur-token", "");
        token.textContent = part;
        fragment.append(token);
        tokens.push(token);
      }
      textNode.replaceWith(fragment);
    }
    return [...element.querySelectorAll("[data-xtr-blur-token], img")]
      .filter((token) => !token.closest(`[${EXPAND_CONTROL_ATTR}]`));
  }

  function completeTranslationReveal(element) {
    const active = revealAnimations.get(element);
    if (!active) return;
    active.tokens.forEach((token) => {
      token.style.opacity = "1";
      token.style.filter = "none";
      token.style.transform = "none";
    });
    active.animations.forEach((animation) => animation.cancel());
    active.tokens.forEach((token) => {
      const original = active.originalStyles.get(token);
      restoreInlineProperty(token, "opacity", original?.opacity, original?.opacityPriority);
      restoreInlineProperty(token, "filter", original?.filter, original?.filterPriority);
      restoreInlineProperty(token, "transform", original?.transform, original?.transformPriority);
    });
    revealAnimations.delete(element);
    element.removeAttribute("data-xtr-reveal");
  }

  function restoreInlineProperty(element, property, value = "", priority = "") {
    if (value) {
      element.style.setProperty(property, value, priority);
    } else {
      element.style.removeProperty(property);
    }
  }

  function finishTranslationReveal(element) {
    if (!element) return;
    const active = revealAnimations.get(element);
    if (active) {
      if (active.settleFrame !== null) cancelAnimationFrame(active.settleFrame);
      completeTranslationReveal(element);
    }
    element.removeAttribute("data-xtr-reveal");
  }

  function shouldRevealTranslation(state, result) {
    const keys = translationPresentationKeys(state);
    const alreadyPresented = keys.some((key) => presentedTranslations.has(key));
    for (const key of keys) {
      presentedTranslations.add(key);
      releasedSources.delete(key);
    }
    while (presentedTranslations.size > 1_000) {
      presentedTranslations.delete(presentedTranslations.values().next().value);
    }
    return result.cached !== true && !alreadyPresented;
  }

  function translationPresentationKeys(state) {
    const contentKey = translationContentKey(state);
    if (!contentKey) return [];
    const postPath = normalizeStatusPath(state?.postKey);
    return postPath
      ? [contentKey, `${postPath}\u0000${contentKey}`]
      : [contentKey];
  }

  function translationContentKey(state) {
    const text = normalizePlainText(state?.translationPlainText || state?.plainText);
    if (!text) return "";
    return `${state?.targetIndex ?? -1}\u0000${text}`;
  }

  function rememberSourceReleased(state) {
    const key = translationContentKey(state);
    if (!key) return;
    releasedSources.add(key);
    while (releasedSources.size > 1_000) {
      releasedSources.delete(releasedSources.values().next().value);
    }
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
      node.removeAttribute(SOURCE_READY_ATTR);
      node.removeAttribute(NATIVE_TRANSLATION_HIDDEN_ATTR);
    });
  }

  function createMetaRow(languageCode, view) {
    const row = document.createElement("div");
    row.dir = "ltr";
    row.setAttribute("data-xtr-owned", "meta");
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
    path.setAttribute("d", SOURCE_ICON_PATH);
    group.append(path);
    icon.append(group);
    return icon;
  }

  function scheduleInitialLoading(state) {
    if (state.view || state.pendingElement || state.loadingTimer !== null) return;
    if (!state.loadingDeadline) {
      const initialDelay = state.retryCount > 0 ? 0 : INITIAL_LOADING_DELAY;
      state.loadingDeadline = Date.now() + initialDelay;
    }
    const delay = Math.max(0, state.loadingDeadline - Date.now());
    state.loadingTimer = setTimeout(() => {
      state.loadingTimer = null;
      state.loadingDeadline = 0;
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
    setEarlyGuard(false);
    rememberSourceReleased(state);
    releaseSource(state.element);
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
    rememberSourceReleased(state);
    releaseSource(state.element);

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
    const message = state.errorKind === "full-text"
      ? "Не удалось получить полный текст · "
      : "Не удалось перевести · ";
    container.append(document.createTextNode(message));
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
      resetFailedExpansion(state);
      if (state.view) {
        clearExpansionPending(state.view);
        showExpansionPending(state.view);
      }
      processTarget(state.element);
    });
    container.append(retry);
  }

  function resetFailedExpansion(state) {
    if (!state?.postKey) return;
    const entry = expansionPrefetches.get(state.postKey);
    if (entry?.status === "error") expansionPrefetches.delete(state.postKey);
  }

  function clearStatePending(state) {
    if (!state) return;
    if (state.loadingTimer !== null) {
      clearTimeout(state.loadingTimer);
      state.loadingTimer = null;
    }
    state.loadingDeadline = 0;
    state.pendingElement?.remove();
    state.pendingElement = null;
  }

  function setOriginalVisible(view, visible) {
    if (!view?.sourceElement || !view.metaElement || !view.translatedElement) return;
    view.showingOriginal = Boolean(visible);
    const text = visible ? "Показать перевод" : "Показать оригинал";
    if (visible) {
      finishTranslationReveal(view.translatedElement);
      releaseSource(view.sourceElement);
      view.sourceElement.removeAttribute("data-xtr-original-hidden");
      view.sourceExpansionControl?.removeAttribute?.(NATIVE_EXPANSION_HIDDEN_ATTR);
      view.translatedElement.hidden = true;
    } else {
      holdSource(view.sourceElement);
      view.sourceElement.setAttribute("data-xtr-original-hidden", "true");
      view.sourceExpansionControl?.setAttribute?.(NATIVE_EXPANSION_HIDDEN_ATTR, "true");
      view.translatedElement.hidden = false;
    }
    if (view.expansionElement) view.expansionElement.hidden = visible;
    if (view.buttonLabel) view.buttonLabel.textContent = text;
    if (view.buttonElement) view.buttonElement.setAttribute("aria-label", text);
  }

  function syncNativeTranslationRow(state) {
    const sourceElement = state?.element || state?.view?.sourceElement;
    if (!sourceElement) return;
    let candidate = sourceElement.previousElementSibling;

    for (let steps = 0; candidate && steps < 4; steps += 1) {
      if (isNativeTranslationRow(candidate)) {
        candidate.setAttribute(NATIVE_TRANSLATION_HIDDEN_ATTR, "true");
        state.nativeTranslationRows ||= new Set();
        state.nativeTranslationRows.add(candidate);
        if (state.view) state.view.nativeTranslationRows = state.nativeTranslationRows;
        return;
      }
      if (candidate.matches?.(PRIMARY_SELECTOR) || candidate.querySelector?.(PRIMARY_SELECTOR)) return;
      candidate = candidate.previousElementSibling;
    }
  }

  function isNativeTranslationRow(element) {
    if (!element || element.matches?.(OWNED_SELECTOR) || element.closest?.(OWNED_SELECTOR)) return false;
    const button = element.querySelector?.(':scope > button[aria-label]');
    const path = element.querySelector?.(':scope > svg[viewBox="0 0 33 32"] path');
    return Boolean(button && path?.getAttribute("d") === SOURCE_ICON_PATH);
  }

  function restoreNativeTranslationRows(state) {
    const rows = state?.nativeTranslationRows || state?.view?.nativeTranslationRows || [];
    for (const row of rows) {
      row.removeAttribute?.(NATIVE_TRANSLATION_HIDDEN_ATTR);
    }
    rows.clear?.();
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
    if (view && view.owner !== state) return;
    restoreNativeTranslationRows(state);
    if (!view) {
      releaseSource(state.element);
      return;
    }
    clearExpansionPending(view);
    view.metaElement?.remove();
    finishTranslationReveal(view.translatedElement);
    view.translatedElement?.remove();
    view.sourceElement?.removeAttribute?.("data-xtr-original-hidden");
    view.sourceExpansionControl?.removeAttribute?.(NATIVE_EXPANSION_HIDDEN_ATTR);
    releaseSource(view.sourceElement);
    state.view = null;
  }

  function ensureViewMounted(state) {
    const view = state?.view;
    const source = state?.element;
    if (!view || view.owner !== state || !source?.isConnected) return;

    const parent = source.parentNode;
    if (!parent) return;
    let repaired = false;

    if (view.metaElement.parentNode !== parent || view.metaElement.nextSibling !== source) {
      source.before(view.metaElement);
      repaired = true;
    }
    if (
      view.translatedElement.parentNode !== parent
      || source.nextSibling !== view.translatedElement
    ) {
      source.after(view.translatedElement);
      repaired = true;
    }
    if (
      view.expansionElement
      && (
        view.expansionElement.parentNode !== parent
        || view.translatedElement.nextSibling !== view.expansionElement
      )
    ) {
      view.translatedElement.after(view.expansionElement);
      repaired = true;
    }

    view.sourceElement = source;
    if (repaired) finishTranslationReveal(view.translatedElement);
    setOriginalVisible(view, view.showingOriginal);
  }

  function setEarlyGuard(active) {
    if (earlyGuardTimer !== null) {
      clearTimeout(earlyGuardTimer);
      earlyGuardTimer = null;
    }

    document.documentElement?.toggleAttribute(EARLY_GUARD_ATTR, Boolean(active));
    if (!active) return;

    earlyGuardTimer = setTimeout(() => {
      earlyGuardTimer = null;
      document.documentElement?.removeAttribute(EARLY_GUARD_ATTR);
    }, EARLY_GUARD_TIMEOUT);
  }

  function holdSource(element) {
    element?.removeAttribute?.(SOURCE_READY_ATTR);
  }

  function releaseSource(element) {
    element?.setAttribute?.(SOURCE_READY_ATTR, "true");
  }

  function removeAllTranslations() {
    const queued = queue.splice(0, queue.length);
    queued.forEach((job) => job.reject(new Error("Перевод выключен.")));
    expansionPrefetches.clear();
    expandedPostTranslations.clear();
    presentedTranslations.clear();
    releasedSources.clear();
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
