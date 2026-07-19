(function xTranslatorContentScript() {
  "use strict";

  const {
    canReuseTranslationView,
    escapeHtml,
    hasTranslatableText,
    languagesMatch,
    normalizePlainText,
  } = XTranslatorCore;
  const {
    EVENT_NAME: TWEET_DATA_EVENT,
    sanitizeTweetDataEnvelope,
  } = XTranslatorTweetData;

  const PRIMARY_SELECTOR = '[data-testid="tweetText"]';
  const PUBLIC_ARTICLE_SELECTOR = 'article[data-tweet-id][itemtype="https://schema.org/SocialMediaPosting"]';
  const OWNED_SELECTOR = "[data-xtr-owned]";
  const NATIVE_TRANSLATION_HIDDEN_ATTR = "data-xtr-native-translation-hidden";
  const NATIVE_EXPANSION_HIDDEN_ATTR = "data-xtr-native-expansion-hidden";
  const EARLY_GUARD_ATTR = "data-xtr-early-guard";
  const SOURCE_READY_ATTR = "data-xtr-source-ready";
  const EXPAND_CONTROL_ATTR = "data-xtr-expand-control";
  const FULL_CONTENT_ATTR = "data-xtr-full-content";
  const NATIVE_SOURCE_ICON_PATH = "M12.745 20.54l10.97-8.19c.539-.4 1.307-.244 1.564.38 1.349 3.288.746 7.241-1.938 9.955-2.683 2.714-6.417 3.31-9.83 1.954l-3.728 1.745c5.347 3.697 11.84 2.782 15.898-1.324 3.219-3.255 4.216-7.692 3.284-11.693l.008.009c-1.351-5.878.332-8.227 3.782-13.031L33 0l-4.54 4.59v-.014L12.743 20.544m-2.263 1.987c-3.837-3.707-3.175-9.446.1-12.755 2.42-2.449 6.388-3.448 9.852-1.979l3.72-1.737c-.67-.49-1.53-1.017-2.515-1.387-4.455-1.854-9.789-.931-13.41 2.728-3.483 3.523-4.579 8.94-2.697 13.561 1.405 3.454-.899 5.898-3.22 8.364C1.49 30.2.666 31.074 0 32l10.478-9.466";
  const BRAND_ICON_PATHS = [
    "M0 8.75C0 6.42936 0.921873 4.20376 2.56282 2.56282C4.20376 0.921873 6.42936 0 8.75 0L39.375 0C41.6956 0 43.9212 0.921873 45.5622 2.56282C47.2031 4.20376 48.125 6.42936 48.125 8.75V21.875H61.25C63.5706 21.875 65.7962 22.7969 67.4372 24.4378C69.0781 26.0788 70 28.3044 70 30.625V61.25C70 63.5706 69.0781 65.7962 67.4372 67.4372C65.7962 69.0781 63.5706 70 61.25 70H30.625C28.3044 70 26.0788 69.0781 24.4378 67.4372C22.7969 65.7962 21.875 63.5706 21.875 61.25V48.125H8.75C6.42936 48.125 4.20376 47.2031 2.56282 45.5622C0.921873 43.9212 0 41.6956 0 39.375V8.75ZM8.75 4.375C7.58968 4.375 6.47688 4.83594 5.65641 5.65641C4.83594 6.47688 4.375 7.58968 4.375 8.75V39.375C4.375 40.5353 4.83594 41.6481 5.65641 42.4686C6.47688 43.2891 7.58968 43.75 8.75 43.75H39.375C40.5353 43.75 41.6481 43.2891 42.4686 42.4686C43.2891 41.6481 43.75 40.5353 43.75 39.375V8.75C43.75 7.58968 43.2891 6.47688 42.4686 5.65641C41.6481 4.83594 40.5353 4.375 39.375 4.375H8.75ZM39.9787 48.1031C40.8231 49.42 41.7375 50.6537 42.735 51.8044C39.4625 54.32 35.4156 56.1838 30.625 57.4569C31.4038 58.4063 32.5981 60.235 33.0531 61.25C37.975 59.6794 42.1531 57.5575 45.6794 54.7137C49.0787 57.6231 53.2875 59.8106 58.4981 61.1537C59.08 60.0425 60.3094 58.2094 61.25 57.26C56.3281 56.1531 52.2506 54.2237 48.9125 51.6425C51.8919 48.3744 54.2587 44.4194 56.0044 39.5806H61.25V35H48.125V39.5806H51.4719C50.0806 43.2731 48.2344 46.3444 45.9069 48.8994C45.264 48.2145 44.6579 47.496 44.0913 46.7469C42.8567 47.5384 41.442 48.005 39.9787 48.1031Z",
    "M32.912 11H37.3572L27.5971 22.0332L39 37H30.0516L23.0457 27.9048L15.025 37H10.5798L20.9197 25.1993L10 11H19.1706L25.5002 19.3085L32.912 11ZM31.3562 34.4096H33.8204L17.8757 13.4945H15.2279L31.3562 34.4096Z",
  ];
  const TARGET_LANGUAGE = "ru";
  const TRANSLATION_CONCURRENCY = 2;
  const RETRY_DELAY = 5_000;
  const MAX_RETRY_DELAY = 30_000;
  const EXPANSION_PREFETCH_LIMIT = 40;
  const TWEET_RECORD_LIMIT = 1_000;
  const TWEET_RECORD_WAIT = 5_000;
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
  const HEIGHT_TRANSITION_MIN_DURATION = 300;
  const HEIGHT_TRANSITION_MAX_DURATION = 620;
  const HEIGHT_TRANSITION_EASING = "cubic-bezier(.22,1,.36,1)";
  const META_STATUS_EXIT_DURATION = 140;
  const META_STATUS_ENTER_DURATION = 220;
  const DEBUG = false;

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
  const heightAnimations = new WeakMap();
  const metaStatusTransitions = new WeakMap();
  const presentedTranslations = new Set();
  const releasedSources = new Set();
  const expandedPostTranslations = new Set();
  const tweetRecords = new Map();
  const tweetRecordWaiters = new Map();

  document.addEventListener(TWEET_DATA_EVENT, handleTweetDataEvent);
  start();

  function handleTweetDataEvent(event) {
    if (typeof event.detail !== "string" || event.detail.length > 20_000_000) return;
    try {
      const envelope = sanitizeTweetDataEnvelope(JSON.parse(event.detail));
      if (!envelope.records.length) return;
      for (const record of envelope.records) storeTweetRecord(record);
      debugLog("tweet data received", {
        operation: envelope.operation,
        ids: envelope.records.map((record) => record.id),
      });
      scheduleScan(0);
    } catch (error) {
      debugLog("tweet data rejected", error);
    }
  }

  function storeTweetRecord(record) {
    const current = tweetRecords.get(record.id);
    const preferred = !current
      || (record.textSource === "note" && current.textSource !== "note")
      || record.text.length > current.text.length
      ? record
      : current;
    tweetRecords.delete(record.id);
    tweetRecords.set(record.id, preferred);
    while (tweetRecords.size > TWEET_RECORD_LIMIT) {
      tweetRecords.delete(tweetRecords.keys().next().value);
    }
    const waiters = tweetRecordWaiters.get(record.id);
    if (!waiters) return;
    tweetRecordWaiters.delete(record.id);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(preferred);
    }
  }

  function waitForTweetRecord(id, timeout = TWEET_RECORD_WAIT) {
    if (!id) return Promise.resolve(null);
    const existing = tweetRecords.get(id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiters = tweetRecordWaiters.get(id) || new Set();
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (!waiters.size) tweetRecordWaiters.delete(id);
          resolve(null);
        }, timeout),
      };
      waiters.add(waiter);
      tweetRecordWaiters.set(id, waiters);
    });
  }

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
    if (!control) return;

    const translatedView = expansionControls.get(control);
    if (translatedView) {
      event.preventDefault();
      event.stopImmediatePropagation();
      expandTranslatedView(translatedView);
      return;
    }

    const state = nativeExpansionControls.get(control) || null;
    if (!state && !isExpansionLabel(control.textContent)) return;
    if (state) rememberTranslationExpanded(state);
    const prepared = state?.targetKey ? expansionPrefetches.get(state.targetKey) : null;
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
    if (!request.hasTranslatableText) {
      const existing = states.get(element);
      if (existing) cleanupState(existing);
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
    const expansionControl = findPostExpansionControl(element, location.targetContainer);
    const isExpandable = Boolean(expansionControl) || isExpandableText(request.plainText);
    const reusableState = previous
      || findAdjacentViewState(element)
      || findContainerState(location, request.plainText);
    const reusableView = reusableState?.view || null;
    const reusablePendingElement = reusableState?.pendingElement?.isConnected
      ? reusableState.pendingElement
      : null;
    const reusableLoadingDeadline = reusableState?.loadingDeadline || 0;
    const reusableWasError = reusableState?.status === "error";
    const reusableErrorKind = reusableState?.errorKind || "";
    const reusableManualRetryRequested = reusableState?.manualRetryRequested === true;
    const reusableSourceWasReleased = Boolean(
      reusableState?.element?.hasAttribute?.(SOURCE_READY_ATTR)
      || reusableWasError,
    );
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
      manualRetryRequested: false,
      forceRevealOnApply: reusableWasError && reusableManualRetryRequested,
      loadingTimer: null,
      loadingDeadline: reusableLoadingDeadline,
      pendingElement: reusablePendingElement,
      view: reusableView,
      containerElement: location.containerElement,
      targetContainer: location.targetContainer,
      targetIndex: location.targetIndex,
      postKey: location.postKey,
      targetKey: location.targetKey,
      resourceId: location.resourceId,
      targetRole: location.targetRole,
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
    if (
      reusableSourceWasReleased
      || element.hasAttribute(SOURCE_READY_ATTR)
      || releasedSources.has(translationContentKey(state))
    ) {
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
      const metaMount = reusableView.metaSlotElement || reusableView.metaElement;
      if (element.previousElementSibling !== metaMount) {
        element.before(metaMount);
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

    // A failed full-text request stays manual even if X replaces the collapsed
    // source after “Show more”. Keep the retry row attached to the active DOM
    // version and wait until the user explicitly retries.
    if (reusableWasError && !reusableManualRetryRequested) {
      state.status = "error";
      state.errorKind = reusableErrorKind;
      state.retryAt = Number.POSITIVE_INFINITY;
      if (!state.pendingElement) showTranslationError(state);
      return;
    }
    if (reusableWasError && state.pendingElement) showRetryProgress(state);

    if (canReuseCompletedTranslation) {
      state.status = "translated";
      ensureViewMounted(state);
      return;
    }

    const prefetched = matchingExpansionPrefetch(state);
    if (prefetched?.status === "ready") {
      state.resourceId = prefetched.resourceId || state.resourceId;
      applyTranslation(state, prefetched.result, prefetched.request, {
        collapsible: state.isExpandable && !state.expandTranslationOnApply,
        expanded: isTranslationExpanded(state),
      });
      return;
    }

    if (state.isExpandable) {
      if (state.resourceId || statusIdFromPath(state.postKey)) {
        const entry = ensureExpansionPrefetch(state);
        waitForExpansionPrefetch(state, entry);
      } else {
        markForRetry(state, 0, "full-text");
      }
      return;
    }

    if (isExpansionReplacement) {
      const pending = expansionPrefetches.get(state.targetKey);
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
      debugLog("translation unavailable", error);
      markForRetry(state, error?.retryAfterMs, error?.xtrKind || "translation");
    });
  }

  function findAdjacentViewState(element) {
    const meta = element.previousElementSibling;
    const translation = element.nextElementSibling;
    if (!meta || !translation) return null;

    for (const state of trackedStates) {
      const viewMeta = state.view?.metaSlotElement || state.view?.metaElement;
      if (viewMeta === meta && state.view?.translatedElement === translation) {
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
      return {
        containerElement: null,
        targetContainer: null,
        targetIndex: -1,
        postKey: "",
        targetKey: "",
        resourceId: "",
        targetRole: "unknown",
      };
    }
    const targets = [...containerElement.querySelectorAll(PRIMARY_SELECTOR)];
    const targetIndex = targets.indexOf(element);
    const targetContainer = findTargetContainer(element, containerElement);
    const statusLink = findStatusLink(containerElement);
    const postKey = statusLink?.getAttribute?.("href") || "";
    const outerId = statusIdFromPath(postKey);
    const targetRole = targetIndex > 0 ? "quote" : "main";
    const scopedId = statusIdFromPath(findStatusLink(targetContainer)?.getAttribute?.("href"));
    const resourceId = targetRole === "main"
      ? outerId
      : scopedId && scopedId !== outerId
        ? scopedId
        : tweetRecords.get(outerId)?.quotedId || "";
    const identity = outerId || normalizeStatusPath(postKey);
    const result = {
      containerElement,
      targetContainer,
      targetIndex,
      postKey,
      targetKey: identity ? `${identity}:${targetRole}:${targetIndex}` : "",
      resourceId,
      targetRole,
    };
    debugLog("target located", {
      postKey: result.postKey,
      targetIndex: result.targetIndex,
      targetKey: result.targetKey,
      resourceId: result.resourceId,
      targetRole: result.targetRole,
    });
    return result;
  }

  function findTargetContainer(element, outerContainer) {
    let scope = element;
    for (let parent = element.parentElement; parent && parent !== outerContainer; parent = parent.parentElement) {
      if (parent.querySelectorAll(PRIMARY_SELECTOR).length !== 1) break;
      scope = parent;
    }
    return scope;
  }

  function findStatusLink(root) {
    if (!root) return null;
    const timed = root.querySelector?.('a[href*="/status/"] time')?.closest?.("a");
    return timed || root.querySelector?.('a[href*="/status/"]') || null;
  }

  function statusIdFromPath(value) {
    return normalizeStatusPath(value).match(/\/status\/(\d+)/u)?.[1] || "";
  }

  function findContainerState(location, plainText) {
    if (!location.containerElement && !location.targetKey) return null;
    let best = null;
    for (const state of trackedStates) {
      if (["removed", "superseded", "skipped"].includes(state.status)) continue;
      const sameContainer = state.containerElement === location.containerElement;
      const samePost = location.targetKey && state.targetKey === location.targetKey;
      if (!canReuseTranslationView({
        sameContainer,
        samePost,
        sourceConnected: state.element.isConnected,
      })) continue;
      if (state.targetKey !== location.targetKey) continue;
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
    if (!state.targetKey) return null;
    return expansionPrefetches.get(state.targetKey) || null;
  }

  function waitForExpansionPrefetch(state, entry) {
    state.status = "loading";
    scheduleInitialLoading(state);
    entry.priority = Math.min(entry.priority, translationPriority(state));

    entry.promise.then((resolved) => {
      if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
      if (resolved.status === "ready" && resolved.request && resolved.result) {
        state.resourceId = resolved.resourceId || state.resourceId;
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
    const existing = expansionPrefetches.get(state.targetKey);
    if (existing && existing.status !== "error") return existing;
    if (existing) expansionPrefetches.delete(state.targetKey);

    const entry = {
      targetKey: state.targetKey,
      postKey: state.postKey,
      targetRole: state.targetRole,
      resourceId: state.resourceId,
      parentResourceId: statusIdFromPath(state.postKey),
      sourceElement: state.element,
      status: "fetching",
      priority: translationPriority(state),
      request: null,
      result: null,
      error: null,
      errorKind: "",
      promise: null,
    };
    expansionPrefetches.set(entry.targetKey, entry);
    entry.promise = prepareExpansionPrefetch(entry);
    trimExpansionPrefetches();
    return entry;
  }

  async function prepareExpansionPrefetch(entry) {
    try {
      try {
        const record = await resolveExpansionRecord(entry);
        if (!record) throw new Error("X ещё не передал полный текст поста.");
        entry.resourceId = record.id;
        entry.request = buildTweetRecordRequest(record, entry.sourceElement);
        if (!entry.request.plainText || !entry.request.hasTranslatableText) {
          throw new Error("В полном тексте нет текста для перевода.");
        }
      } catch (error) {
        error.xtrKind = "full-text";
        throw error;
      }

      entry.status = "queued";
      entry.result = await requestTranslation({
        id: `full:${entry.resourceId}`,
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
      debugLog("full post preparation failed", error);
    } finally {
      trimExpansionPrefetches();
    }
    return entry;
  }

  async function resolveExpansionRecord(entry) {
    if (entry.resourceId) return waitForTweetRecord(entry.resourceId);
    if (entry.targetRole !== "quote") {
      return waitForTweetRecord(entry.parentResourceId);
    }
    const parent = await waitForTweetRecord(entry.parentResourceId);
    if (!parent?.quotedId) return null;
    entry.resourceId = parent.quotedId;
    return waitForTweetRecord(parent.quotedId);
  }

  function normalizeStatusPath(value) {
    try {
      return new URL(value, location.origin).pathname.replace(/\/$/u, "");
    } catch {
      return "";
    }
  }

  function debugLog(event, details) {
    if (!DEBUG) return;
    console.debug(`[X Translator][debug] ${event}`, details);
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
    const translatableText = [];
    const html = [...element.childNodes]
      .map((node) => serializeNode(node, tokens, translatableText))
      .join("");
    return {
      plainText: normalizePlainText(
        preferTextContent ? element.textContent : element.innerText || element.textContent,
      ),
      html: `<div>${html}</div>`,
      tokens,
      hasTranslatableText: hasTranslatableText(translatableText.join(" ")),
    };
  }

  function buildTweetRecordRequest(record, sourceElement) {
    const root = document.createElement("div");
    const fullText = String(record.text || "");
    const [displayStart, displayEnd] = record.textSource === "note" || !record.displayRange
      ? [0, fullText.length]
      : normalizeDisplayRange(fullText, record.displayRange);
    const text = fullText.slice(displayStart, displayEnd);
    const ranges = [];
    let searchCursor = displayStart;

    for (const entity of record.entities || []) {
      const range = resolveEntityRange(fullText, entity, searchCursor);
      if (!range || range[0] < displayStart || range[1] > displayEnd) continue;
      if (ranges.some((item) => range[0] < item.end && range[1] > item.start)) continue;
      ranges.push({ start: range[0], end: range[1], entity });
      searchCursor = range[1];
    }
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);

    let cursor = 0;
    for (const item of ranges) {
      const start = item.start - displayStart;
      const end = item.end - displayStart;
      if (start > cursor) root.append(document.createTextNode(text.slice(cursor, start)));
      if (item.entity.type !== "media") {
        root.append(createRecordEntityElement(item.entity, sourceElement));
      }
      cursor = end;
    }
    if (cursor < text.length) root.append(document.createTextNode(text.slice(cursor)));
    return buildRequest(root, true);
  }

  function normalizeDisplayRange(text, range) {
    const direct = [
      Math.max(0, Math.min(text.length, Number(range[0]) || 0)),
      Math.max(0, Math.min(text.length, Number(range[1]) || text.length)),
    ];
    if (direct[1] > direct[0]) return direct;
    return [0, text.length];
  }

  function codePointOffset(text, index) {
    return Array.from(text).slice(0, Math.max(0, index)).join("").length;
  }

  function resolveEntityRange(text, entity, cursor = 0) {
    const raw = String(entity.raw || "");
    if (!raw) return null;
    const [start, end] = entity.indices || [];
    const candidates = [
      [start, end],
      [codePointOffset(text, start), codePointOffset(text, end)],
    ];
    for (const candidate of candidates) {
      if (
        Number.isInteger(candidate[0])
        && Number.isInteger(candidate[1])
        && text.slice(candidate[0], candidate[1]) === raw
      ) return candidate;
    }
    let located = text.indexOf(raw, Math.max(0, cursor));
    if (located < 0) located = text.indexOf(raw);
    return located >= 0 ? [located, located + raw.length] : null;
  }

  function createRecordEntityElement(entity, sourceElement) {
    const display = entity.display || entity.raw;
    const href = safeRecordHref(entity.href);
    const matching = [...(sourceElement?.querySelectorAll?.("a") || [])]
      .find((anchor) => {
        const text = normalizePlainText(anchor.textContent);
        return text === normalizePlainText(display) || text === normalizePlainText(entity.raw);
      });
    const anchor = matching?.cloneNode(true) || document.createElement("a");
    stripConflictingAttributes(anchor, true);
    anchor.textContent = display;
    if (href) anchor.setAttribute("href", href);
    else anchor.removeAttribute("href");
    if (!matching) {
      anchor.dir = "ltr";
      anchor.setAttribute("role", "link");
      anchor.style.color = "rgb(29, 155, 240)";
      anchor.style.textDecoration = "none";
    }
    return anchor;
  }

  function safeRecordHref(value) {
    if (typeof value !== "string" || !/^https:\/\//iu.test(value)) return "";
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? value : "";
    } catch {
      return "";
    }
  }

  function serializeNode(node, tokens, translatableText) {
    if (node.nodeType === Node.TEXT_NODE) {
      return serializeText(node.nodeValue || "", tokens, translatableText);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const tag = node.tagName.toLowerCase();
    if (tag === "br") return "<br/>";

    if (tag === "a" || tag === "img") {
      return serializeProtectedElement(node, tokens);
    }

    return [...node.childNodes]
      .map((child) => serializeNode(child, tokens, translatableText))
      .join("");
  }

  function serializeText(value, tokens, translatableText) {
    const parts = String(value).split(/((?:https?:\/\/|www\.)\S+|@[\p{L}\p{N}_]+|#[\p{L}\p{N}_]+|\$[A-Z][A-Z0-9_]*)/gu);
    return parts.map((part) => {
      if (!part) return "";
      if (/^(?:https?:\/\/|www\.|@|#|\$[A-Z])/u.test(part)) {
        return serializeProtectedText(part, tokens);
      }
      translatableText.push(part);
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
    state.manualRetryRequested = false;
    state.retryAt = errorKind === "full-text"
      ? Number.POSITIVE_INFINITY
      : Date.now() + delay;
    if (!state.view) restoreNativeTranslationRows(state);
    showTranslationError(state);
    if (errorKind === "full-text") return;
    setTimeout(() => {
      if (!enabled || !state.element.isConnected || states.get(state.element) !== state) return;
      showRetryProgress(state);
      processTarget(state.element);
    }, delay + 25);
  }

  function applyTranslation(state, result, request = state, options = {}) {
    if (!result?.translatedHtml || !state.element.isConnected) {
      markForRetry(state);
      return;
    }
    if (states.get(state.element) !== state) return;
    const pendingSlot = state.pendingElement?.isConnected
      ? state.pendingElement
      : null;
    const pendingHeight = pendingSlot
      ? pendingSlot.getBoundingClientRect().height
      : 0;
    const sourceHeight = state.collapsedMetrics?.totalHeight
      || state.element.getBoundingClientRect().height;
    const previousTextHeight = state.view && !state.view.showingOriginal
      ? state.view.translatedElement.getBoundingClientRect().height
        + (state.view.expansionElement && !state.view.expansionElement.hidden
          ? state.view.expansionElement.getBoundingClientRect().height
          : 0)
      : sourceHeight;
    if (languagesMatch(result.detectedLanguage, TARGET_LANGUAGE)) {
      clearStatePending(state);
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
      clearStatePending(state);
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
    const collapsible = Boolean(options.collapsible && state.collapsedMetrics?.control);
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
    const retainedMetaSlot = takeStatePending(state);

    if (state.view) {
      retainedMetaSlot?.remove();
      const view = state.view;
      finishTranslationReveal(view.translatedElement);
      finishHeightTransition(view.translatedElement);
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
      if (!view.showingOriginal) {
        transitionHeightFrom(translated, previousTextHeight);
      }
      syncNativeTranslationRow(state);
      state.status = "translated";
      return;
    }

    const view = {
      owner: state,
      sourceElement: state.element,
      metaElement: null,
      metaSlotElement: null,
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
    const metaSlot = retainedMetaSlot || createMetaSlot(meta);
    view.metaSlotElement = metaSlot;
    state.view = view;
    if (!metaSlot.isConnected) state.element.before(metaSlot);
    if (retainedMetaSlot) transitionMetaSlotContent(metaSlot, meta);
    state.element.after(translated);
    applyTranslationExpansion(view);
    setOriginalVisible(view, false);
    if (shouldReveal) revealTranslation(translated);
    if (!retainedMetaSlot) transitionHeightFrom(metaSlot, pendingHeight);
    transitionHeightFrom(translated, sourceHeight);
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
    const nativeButton = [...element.querySelectorAll('button, [role="button"]:not(a)')]
      .find((candidate) => !candidate.closest(OWNED_SELECTOR));
    if (nativeButton) return nativeButton;

    return [...element.querySelectorAll('button, a, [role="button"]')]
      .find((candidate) => (
        !candidate.closest(OWNED_SELECTOR)
        && isExpansionLabel(candidate.textContent)
      )) || null;
  }

  function createTranslatedExpansionControl(state) {
    const control = state.collapsedMetrics?.control?.cloneNode(true)
      || document.createElement("button");
    stripConflictingAttributes(control, true);
    control.hidden = false;
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
    return state?.resourceId || state?.targetKey || "";
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
      beforeAnimate: () => animateHeightChange(
        view.translatedElement,
        () => applyTranslationExpansion(view),
      ),
    });
  }

  function animateHeightChange(element, mutate) {
    if (!element) {
      mutate?.();
      return;
    }
    const startHeight = element.getBoundingClientRect().height;
    finishHeightTransition(element);
    mutate?.();
    transitionHeightFrom(element, startHeight);
  }

  function transitionHeightFrom(element, startHeight) {
    if (!element?.isConnected) return;
    finishHeightTransition(element);

    const endHeight = element.getBoundingClientRect().height;
    const delta = Math.abs(endHeight - startHeight);
    if (
      !Number.isFinite(startHeight)
      || !Number.isFinite(endHeight)
      || delta < 1
      || element.hidden
      || !isHeightTransitionVisible(element)
      || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    ) return;

    const finalHeight = element.style.getPropertyValue("height");
    const finalHeightPriority = element.style.getPropertyPriority("height");
    const duration = Math.min(
      HEIGHT_TRANSITION_MAX_DURATION,
      HEIGHT_TRANSITION_MIN_DURATION + (delta * 0.55),
    );

    element.setAttribute("data-xtr-height-transition", "");
    element.style.height = `${Math.max(0, startHeight)}px`;
    const animation = element.animate(
      [
        { height: `${Math.max(0, startHeight)}px` },
        { height: `${Math.max(0, endHeight)}px` },
      ],
      {
        duration,
        easing: HEIGHT_TRANSITION_EASING,
        fill: "forwards",
      },
    );
    const active = {
      animation,
      finalHeight,
      finalHeightPriority,
      settleFrame: null,
    };
    heightAnimations.set(element, active);

    animation.finished.catch(() => undefined).then(() => {
      if (heightAnimations.get(element) !== active) return;
      active.settleFrame = requestAnimationFrame(() => completeHeightTransition(element));
    });
  }

  function isHeightTransitionVisible(element) {
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 800;
    return rect.bottom >= -32 && rect.top <= viewportHeight + 32;
  }

  function completeHeightTransition(element) {
    const active = heightAnimations.get(element);
    if (!active) return;
    if (active.settleFrame !== null) cancelAnimationFrame(active.settleFrame);
    active.animation.cancel();
    restoreInlineProperty(
      element,
      "height",
      active.finalHeight,
      active.finalHeightPriority,
    );
    element.removeAttribute("data-xtr-height-transition");
    heightAnimations.delete(element);
  }

  function finishHeightTransition(element) {
    if (!element) return;
    const active = heightAnimations.get(element);
    if (active) completeHeightTransition(element);
    element.removeAttribute("data-xtr-height-transition");
  }

  function transitionMetaSlotContent(slot, nextElement) {
    if (!slot || !nextElement) return;
    finishMetaStatusTransition(slot);
    const previousElement = slot.firstElementChild;
    if (!previousElement || previousElement === nextElement) {
      slot.replaceChildren(nextElement);
      return;
    }
    if (
      !slot.isConnected
      || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    ) {
      slot.replaceChildren(nextElement);
      return;
    }

    const exitAnimation = previousElement.animate(
      [
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(-2px)" },
      ],
      {
        duration: META_STATUS_EXIT_DURATION,
        easing: "ease-out",
        fill: "forwards",
      },
    );
    const active = {
      animations: [exitAnimation],
      nextElement,
    };
    metaStatusTransitions.set(slot, active);

    exitAnimation.finished.catch(() => undefined).then(() => {
      if (metaStatusTransitions.get(slot) !== active) return;
      const startHeight = slot.getBoundingClientRect().height;
      exitAnimation.cancel();
      slot.replaceChildren(nextElement);
      transitionHeightFrom(slot, startHeight);

      const enterAnimation = nextElement.animate(
        [
          { opacity: 0, transform: "translateY(2px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: META_STATUS_ENTER_DURATION,
          easing: HEIGHT_TRANSITION_EASING,
          fill: "forwards",
        },
      );
      active.animations = [enterAnimation];
      return enterAnimation.finished.catch(() => undefined).then(() => {
        if (metaStatusTransitions.get(slot) !== active) return;
        enterAnimation.cancel();
        metaStatusTransitions.delete(slot);
      });
    });
  }

  function finishMetaStatusTransition(slot) {
    if (!slot) return;
    const active = metaStatusTransitions.get(slot);
    if (!active) return;
    active.animations.forEach((animation) => animation.cancel());
    if (active.nextElement) slot.replaceChildren(active.nextElement);
    metaStatusTransitions.delete(slot);
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
    const forceReveal = state?.forceRevealOnApply === true;
    if (state) state.forceRevealOnApply = false;
    for (const key of keys) {
      presentedTranslations.add(key);
      releasedSources.delete(key);
    }
    while (presentedTranslations.size > 1_000) {
      presentedTranslations.delete(presentedTranslations.values().next().value);
    }
    return forceReveal || (result.cached !== true && !alreadyPresented);
  }

  function translationPresentationKeys(state) {
    const contentKey = translationContentKey(state);
    if (!contentKey) return [];
    const resourceKey = state?.resourceId || state?.targetKey || "";
    return resourceKey ? [contentKey, `${resourceKey}\u0000${contentKey}`] : [contentKey];
  }

  function translationContentKey(state) {
    const text = normalizePlainText(state?.translationPlainText || state?.plainText);
    if (!text) return "";
    const identity = state?.resourceId || state?.targetKey || String(state?.targetIndex ?? -1);
    return `${identity}\u0000${text}`;
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
      [...node.attributes].forEach((attribute) => {
        if (attribute.name.startsWith("data-xtr-")) {
          node.removeAttribute(attribute.name);
        }
      });
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
      setOriginalVisible(view, !view.showingOriginal, { animate: true });
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
    icon.setAttribute("viewBox", "0 0 70 70");
    icon.setAttribute("aria-hidden", "true");
    const group = document.createElementNS(namespace, "g");
    BRAND_ICON_PATHS.forEach((pathData) => {
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("d", pathData);
      path.setAttribute("fill", "currentColor");
      group.append(path);
    });
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
    const slot = createMetaSlot(row);
    state.element.before(slot);
    state.pendingElement = slot;
    transitionHeightFrom(slot, 0);
  }

  function createMetaSlot(content) {
    const slot = document.createElement("div");
    slot.setAttribute("data-xtr-owned", "meta-slot");
    slot.setAttribute("data-xtr-meta-slot", "");
    if (content) slot.append(content);
    return slot;
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
    if (!indicator.hidden) transitionHeightFrom(indicator, 0);
  }

  function clearExpansionPending(view) {
    finishHeightTransition(view?.expansionElement);
    view?.expansionElement?.remove();
    if (view) view.expansionElement = null;
  }

  function showTranslationError(state) {
    rememberSourceReleased(state);
    releaseSource(state.element);

    if (state.view) {
      clearStatePending(state);
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
      if (!indicator.hidden) transitionHeightFrom(indicator, 0);
      return;
    }

    const row = createMetaStatusRow();
    const text = row.querySelector('[data-xtr-status-text]');
    const label = text.parentElement;
    text.remove();
    appendRetryContent(label, state);
    const slot = takeStatePending(state) || createMetaSlot(row);
    if (!slot.isConnected) state.element.before(slot);
    if (slot.firstElementChild !== row) transitionMetaSlotContent(slot, row);
    state.pendingElement = slot;
    if (slot.firstElementChild === row) transitionHeightFrom(slot, 0);
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
      const activeState = resolveActiveRetryState(state);
      if (!enabled || !activeState) return;
      if (["queued", "loading"].includes(activeState.status)) {
        showRetryProgress(activeState);
        return;
      }
      if (["translated", "skipped"].includes(activeState.status)) return;
      activeState.retryAt = 0;
      activeState.manualRetryRequested = true;
      activeState.status = "error";
      showRetryProgress(activeState);
      processTarget(activeState.element);
    });
    container.append(retry);
  }

  function resolveActiveRetryState(state) {
    if (state?.element?.isConnected && states.get(state.element) === state) return state;

    let latest = null;
    for (const candidate of trackedStates) {
      if (!candidate.element?.isConnected) continue;
      if (state?.targetKey && candidate.targetKey !== state.targetKey) continue;
      if (!state?.targetKey && candidate.containerElement !== state?.containerElement) continue;
      if (!latest || Number(candidate.requestId) > Number(latest.requestId)) latest = candidate;
    }
    return latest;
  }

  function resetFailedExpansion(state) {
    if (!state?.targetKey) return;
    const entry = expansionPrefetches.get(state.targetKey);
    if (entry?.status === "error") expansionPrefetches.delete(state.targetKey);
  }

  function showRetryProgress(state) {
    resetFailedExpansion(state);
    if (state.view) {
      clearExpansionPending(state.view);
      showExpansionPending(state.view);
      return;
    }

    const row = createMetaStatusRow();
    const text = row.querySelector('[data-xtr-status-text]');
    text.textContent = "Перевожу…";
    text.classList.add("xtr-shimmer");
    const slot = state.pendingElement?.isConnected
      ? state.pendingElement
      : createMetaSlot(row);
    if (!slot.isConnected) state.element.before(slot);
    if (slot.firstElementChild !== row) transitionMetaSlotContent(slot, row);
    state.pendingElement = slot;
  }

  function takeStatePending(state) {
    if (!state) return;
    if (state.loadingTimer !== null) {
      clearTimeout(state.loadingTimer);
      state.loadingTimer = null;
    }
    state.loadingDeadline = 0;
    const pending = state.pendingElement;
    state.pendingElement = null;
    return pending;
  }

  function clearStatePending(state) {
    const pending = takeStatePending(state);
    finishMetaStatusTransition(pending);
    finishHeightTransition(pending);
    pending?.remove();
  }

  function setOriginalVisible(view, visible, options = {}) {
    if (!view?.sourceElement || !view.metaElement || !view.translatedElement) return;
    const nextShowingOriginal = Boolean(visible);
    const visibilityChanges = view.showingOriginal !== nextShowingOriginal;
    const currentElement = view.showingOriginal ? view.sourceElement : view.translatedElement;
    const nextElement = nextShowingOriginal ? view.sourceElement : view.translatedElement;
    const startHeight = visibilityChanges
      ? currentElement.getBoundingClientRect().height
      : 0;
    if (visibilityChanges) {
      finishHeightTransition(currentElement);
      finishHeightTransition(nextElement);
    }
    view.showingOriginal = nextShowingOriginal;
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
    if (visibilityChanges && options.animate) {
      transitionHeightFrom(nextElement, startHeight);
    }
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
    return Boolean(button && path?.getAttribute("d") === NATIVE_SOURCE_ICON_PATH);
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
    const metaMount = view.metaSlotElement || view.metaElement;
    finishMetaStatusTransition(view.metaSlotElement);
    finishHeightTransition(metaMount);
    finishHeightTransition(view.translatedElement);
    metaMount?.remove();
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
    const metaMount = view.metaSlotElement || view.metaElement;

    if (metaMount.parentNode !== parent || metaMount.nextSibling !== source) {
      source.before(metaMount);
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
    if (repaired) {
      finishTranslationReveal(view.translatedElement);
      finishMetaStatusTransition(view.metaSlotElement);
      finishHeightTransition(metaMount);
      finishHeightTransition(view.translatedElement);
    }
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
