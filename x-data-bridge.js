(function installXDataBridge(global) {
  "use strict";

  const VERSION = 1;
  const EVENT_NAME = "x-translator:tweet-data";
  const MAX_RECORDS = 400;
  const MAX_TEXT_LENGTH = 100000;
  const MAX_ENTITIES = 500;
  const ID_PATTERN = /^\d{1,30}$/;
  const GRAPHQL_PATH = /\/i\/api\/graphql\/[^/]+\/([^/?#]+)/u;
  const X_API_PATH = /^\/(?:i\/api\/|1\.1\/|2\/)/u;
  const xhrRequests = new WeakMap();

  function decodeHtmlEntities(value) {
    return String(value || "").replace(
      /&(?:amp|lt|gt|quot|#39|apos);/g,
      (entity) => ({
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#39;": "'",
        "&apos;": "'",
      })[entity] || entity,
    );
  }

  function safeId(value) {
    const id = typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";
    return ID_PATTERN.test(id) ? id : "";
  }

  function safeIndices(value) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const start = Number(value[0]);
    const end = Number(value[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      return null;
    }
    return [start, end];
  }

  function safeUrl(value) {
    if (typeof value !== "string" || value.length > 4096 || !/^https:\/\//i.test(value)) {
      return "";
    }
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? value : "";
    } catch {
      return "";
    }
  }

  function normalizeEntity(type, entity) {
    if (!entity || typeof entity !== "object") return null;
    const indices = safeIndices(entity.indices);
    if (!indices) return null;

    if (type === "url" || type === "media") {
      const raw = typeof entity.url === "string" ? entity.url.slice(0, 2048) : "";
      if (!raw) return null;
      return {
        type,
        indices,
        raw,
        display: decodeHtmlEntities(entity.display_url || raw).slice(0, 2048),
        href: safeUrl(entity.expanded_url || entity.media_url_https || raw),
      };
    }

    const prefix = type === "mention" ? "@" : type === "hashtag" ? "#" : "$";
    const name = String(type === "mention" ? entity.screen_name : entity.text || "")
      .replace(/^[@#$]/, "")
      .slice(0, 256);
    if (!name) return null;
    return {
      type,
      indices,
      raw: `${prefix}${name}`,
      display: `${prefix}${name}`,
      href: type === "mention"
        ? `https://x.com/${encodeURIComponent(name)}`
        : `https://x.com/search?q=${encodeURIComponent(`${prefix}${name}`)}`,
    };
  }

  function normalizeEntities(entitySet) {
    if (!entitySet || typeof entitySet !== "object") return [];
    const groups = [
      ["url", entitySet.urls],
      ["media", entitySet.media],
      ["mention", entitySet.user_mentions],
      ["hashtag", entitySet.hashtags],
      ["cashtag", entitySet.symbols],
    ];
    const entities = [];
    for (const [type, values] of groups) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const normalized = normalizeEntity(type, value);
        if (normalized) entities.push(normalized);
        if (entities.length >= MAX_ENTITIES) break;
      }
      if (entities.length >= MAX_ENTITIES) break;
    }
    entities.sort((a, b) => a.indices[0] - b.indices[0] || a.indices[1] - b.indices[1]);
    return entities;
  }

  function unwrapTweet(value) {
    if (!value || typeof value !== "object") return null;
    if (value.__typename === "TweetWithVisibilityResults" && value.tweet) return value.tweet;
    return value;
  }

  function quotedTweetId(tweet) {
    return safeId(unwrapTweet(tweet?.quoted_status_result?.result)?.rest_id);
  }

  function recordFromTweet(input) {
    const tweet = unwrapTweet(input);
    if (!tweet || typeof tweet !== "object") return null;
    const id = safeId(tweet.rest_id);
    if (!id) return null;

    const note = tweet.note_tweet?.note_tweet_results?.result;
    const legacy = tweet.legacy && typeof tweet.legacy === "object" ? tweet.legacy : null;
    const noteText = typeof note?.text === "string" ? note.text : "";
    const fallbackText = typeof legacy?.full_text === "string"
      ? legacy.full_text
      : typeof tweet.full_text === "string"
        ? tweet.full_text
        : "";
    const rawText = noteText || fallbackText;
    if (!rawText || rawText.length > MAX_TEXT_LENGTH) return null;

    const source = noteText ? "note" : "legacy";
    const rawRange = source === "note"
      ? null
      : legacy?.display_text_range || tweet.display_text_range;
    const entitySet = source === "note"
      ? note.entity_set || note.entities
      : legacy?.entities || tweet.entities;

    return {
      id,
      text: decodeHtmlEntities(rawText),
      lang: String(legacy?.lang || tweet.lang || note?.lang || "").slice(0, 32),
      textSource: source,
      displayRange: rawRange == null ? null : safeIndices(rawRange),
      entities: normalizeEntities(entitySet),
      quotedId: quotedTweetId(tweet),
    };
  }

  function isTweetCandidate(value) {
    if (!value || typeof value !== "object") return false;
    if (value.__typename === "Tweet" || value.__typename === "TweetWithVisibilityResults") {
      return true;
    }
    return Boolean(value.rest_id && (
      value.legacy?.full_text
      || value.full_text
      || value.note_tweet?.note_tweet_results?.result?.text
    ));
  }

  function preferRecord(current, candidate) {
    if (!current) return candidate;
    if (candidate.textSource === "note" && current.textSource !== "note") return candidate;
    if (candidate.text.length > current.text.length) return candidate;
    return {
      ...current,
      quotedId: current.quotedId || candidate.quotedId,
      lang: current.lang || candidate.lang,
      entities: current.entities.length ? current.entities : candidate.entities,
    };
  }

  function collectTweetRecords(payload) {
    if (!payload || typeof payload !== "object") return [];
    const records = new Map();
    const seen = new Set();
    const stack = [payload];
    let visited = 0;

    while (stack.length && records.size < MAX_RECORDS && visited < 100000) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      visited += 1;

      if (isTweetCandidate(value)) {
        const record = recordFromTweet(value);
        if (record) records.set(record.id, preferRecord(records.get(record.id), record));
      }

      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
      } else {
        for (const child of Object.values(value)) stack.push(child);
      }
    }

    return Array.from(records.values());
  }

  function requestDescriptor(value) {
    let url = "";
    if (typeof value === "string") url = value;
    else if (value && typeof value.url === "string") url = value.url;
    if (!url) return null;

    let parsed;
    try {
      parsed = new URL(url, global.location?.href || "https://x.com/");
    } catch {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    const isXHost = hostname === "x.com"
      || hostname.endsWith(".x.com")
      || hostname === "twitter.com"
      || hostname.endsWith(".twitter.com");
    if (!isXHost || !X_API_PATH.test(parsed.pathname)) return null;

    const graphqlMatch = parsed.pathname.match(GRAPHQL_PATH);
    if (graphqlMatch) {
      try {
        return { url: parsed.href, operation: decodeURIComponent(graphqlMatch[1]) };
      } catch {
        return { url: parsed.href, operation: graphqlMatch[1] };
      }
    }

    const name = parsed.pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.json$/u, "") || "api";
    return { url: parsed.href, operation: `api_${name}` };
  }

  function publish(operation, records) {
    if (!records.length) return;
    document.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: JSON.stringify({
        version: VERSION,
        operation: String(operation || "unknown")
          .replace(/[^A-Za-z0-9_]/g, "")
          .slice(0, 100),
        records: records.slice(0, MAX_RECORDS),
      }),
    }));
  }

  function inspectPayload(payload, operation) {
    publish(operation, collectTweetRecords(payload));
  }

  async function inspectFetchResponse(response, operation) {
    if (!response || !response.ok || response.type === "opaque") return;
    const contentType = response.headers?.get?.("content-type") || "";
    if (contentType && !/json/i.test(contentType)) return;
    const payload = await response.clone().json();
    inspectPayload(payload, operation);
  }

  function inspectXhrResponse(request, operation) {
    if (!request || request.status < 200 || request.status >= 300) return;
    const contentType = request.getResponseHeader?.("content-type") || "";
    if (contentType && !/json/i.test(contentType)) return;

    let payload;
    if (request.responseType === "json") {
      payload = request.response;
    } else if (!request.responseType || request.responseType === "text") {
      const text = typeof request.responseText === "string"
        ? request.responseText
        : request.response;
      if (typeof text !== "string" || !text) return;
      payload = JSON.parse(text);
    } else {
      return;
    }
    inspectPayload(payload, operation);
  }

  function observeFetch() {
    if (typeof global.fetch !== "function") return;
    const originalFetch = global.fetch;
    global.fetch = new Proxy(originalFetch, {
      apply(target, thisArg, argumentsList) {
        const descriptor = requestDescriptor(argumentsList[0]);
        const result = Reflect.apply(target, thisArg, argumentsList);
        if (descriptor) {
          Promise.resolve(result)
            .then((response) => inspectFetchResponse(response, descriptor.operation))
            .catch(() => {});
        }
        return result;
      },
    });
  }

  function observeXhr() {
    const Xhr = global.XMLHttpRequest;
    const prototype = Xhr?.prototype;
    if (
      typeof Xhr !== "function"
      || typeof prototype?.open !== "function"
      || typeof prototype?.send !== "function"
    ) return;

    const originalOpen = prototype.open;
    const originalSend = prototype.send;

    prototype.open = new Proxy(originalOpen, {
      apply(target, thisArg, argumentsList) {
        const result = Reflect.apply(target, thisArg, argumentsList);
        xhrRequests.set(thisArg, requestDescriptor(argumentsList[1]));
        return result;
      },
    });

    prototype.send = new Proxy(originalSend, {
      apply(target, thisArg, argumentsList) {
        const descriptor = xhrRequests.get(thisArg);
        if (!descriptor || typeof thisArg.addEventListener !== "function") {
          return Reflect.apply(target, thisArg, argumentsList);
        }

        const onLoad = () => {
          try {
            inspectXhrResponse(thisArg, descriptor.operation);
          } catch {
            // Never let response inspection affect X itself.
          }
        };
        const cleanup = () => {
          thisArg.removeEventListener?.("load", onLoad);
          thisArg.removeEventListener?.("loadend", cleanup);
        };
        thisArg.addEventListener("load", onLoad);
        thisArg.addEventListener("loadend", cleanup);

        try {
          return Reflect.apply(target, thisArg, argumentsList);
        } catch (error) {
          cleanup();
          throw error;
        }
      },
    });
  }

  global.XTranslatorPageBridge = Object.freeze({
    VERSION,
    EVENT_NAME,
    collectTweetRecords,
  });

  if (typeof document === "undefined" || typeof document.dispatchEvent !== "function") return;
  observeFetch();
  observeXhr();
})(globalThis);
