"use strict";

importScripts("shared.js");

const BING_HOME_URL = "https://www.bing.com/translator";
const BING_TRANSLATE_URL = "https://www.bing.com/ttranslatev3";
const CACHE_KEY = "translationCacheV2";
const STATS_KEY = "translationStatsV1";
const CACHE_LIMIT = 800;
const MAX_BATCH_ITEMS = 30;
const MAX_BATCH_CHARACTERS = 30_000;
const MAX_BING_TEXT = 950;
const BING_CONCURRENCY = 2;
const SESSION_TTL = 25 * 60_000;
const DEFAULT_RATE_LIMIT_PAUSE = 5 * 60_000;

const DEFAULTS = Object.freeze({
  enabled: true,
  targetLanguage: "ru",
});

let cachePromise;
let statsQueue = Promise.resolve();
let bingSession = null;
let sessionPromise = null;
let bingBlockedUntil = 0;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set(current);
  await chrome.storage.local.remove(["translatorApiKey", "translatorRegion", "translationCacheV1"]);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error("[X Translator]", error);
      sendResponse({
        ok: false,
        code: error?.code || "UNKNOWN",
        error: friendlyError(error),
        retryAfterMs: Number(error?.retryAfterMs || 0),
      });
    });
  return true;
});

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Некорректный запрос." };
  }

  if (message.type === "TRANSLATE_BATCH") {
    return translateBatch(Array.isArray(message.items) ? message.items : []);
  }

  if (message.type === "TEST_TRANSLATOR") {
    const result = await translateBingText("This update is fire, no cap.", "ru");
    return {
      ok: true,
      translatedText: result.text,
      detectedLanguage: result.detectedLanguage || "en",
    };
  }

  if (message.type === "CLEAR_CACHE") {
    const cache = await getCache();
    cache.clear();
    await chrome.storage.local.remove(CACHE_KEY);
    return { ok: true };
  }

  if (message.type === "RESET_BING_SESSION") {
    invalidateBingSession();
    bingBlockedUntil = 0;
    return { ok: true };
  }

  return { ok: false, error: "Неизвестный тип запроса." };
}

async function translateBatch(rawItems) {
  const items = sanitizeBatch(rawItems);
  if (!items.length) return { ok: true, results: [] };

  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.enabled) {
    return { ok: false, code: "DISABLED", error: "Перевод выключен." };
  }

  const cache = await getCache();
  const results = new Array(items.length);
  const misses = [];
  let cacheHits = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const cacheId = await cacheKey(settings.targetLanguage, item.html);
    const cached = cache.get(cacheId);
    if (cached) {
      cached.accessedAt = Date.now();
      results[index] = { id: item.id, ...cached.value, cached: true };
      cacheHits += 1;
    } else {
      misses.push({ index, item, cacheId });
    }
  }

  let translatedCharacters = 0;
  if (misses.length) {
    let translated;
    try {
      translated = await mapWithConcurrency(misses, BING_CONCURRENCY, async ({ item }) => (
        translatePreparedItem(item, settings.targetLanguage || "ru")
      ));
    } catch (error) {
      await updateStats({ errors: 1 });
      throw error;
    }

    misses.forEach((miss, apiIndex) => {
      const value = translated[apiIndex];
      results[miss.index] = { id: miss.item.id, ...value, cached: false };
      translatedCharacters += miss.item.plainText.length;
      cache.set(miss.cacheId, { value, accessedAt: Date.now() });
    });

    trimCache(cache);
    await persistCache(cache);
  }

  await updateStats({
    total: results.length,
    cacheHits,
    characters: translatedCharacters,
  });

  return { ok: true, results };
}

function sanitizeBatch(rawItems) {
  const result = [];
  let characters = 0;

  for (const raw of rawItems.slice(0, MAX_BATCH_ITEMS)) {
    const html = typeof raw?.html === "string" ? raw.html.trim() : "";
    const plainText = typeof raw?.plainText === "string" ? raw.plainText.trim() : "";
    if (!html || !plainText) continue;
    if (characters + html.length > MAX_BATCH_CHARACTERS) break;
    characters += html.length;
    result.push({ id: String(raw.id || result.length), html, plainText });
  }

  return result;
}

async function translatePreparedItem(item, targetLanguage) {
  const prepared = prepareBingText(item.html);
  const chunks = splitBingText(prepared.text, MAX_BING_TEXT);
  const translatedParts = [];
  let detectedLanguage = "";

  for (const chunk of chunks) {
    const result = await translateBingText(chunk.text, targetLanguage);
    translatedParts.push(result.text, chunk.separator);
    if (!detectedLanguage && result.detectedLanguage) {
      detectedLanguage = result.detectedLanguage;
    }
  }

  return {
    translatedHtml: restoreProtectedTokens(translatedParts.join(""), prepared.tokens),
    detectedLanguage,
    confidence: null,
  };
}

function prepareBingText(html) {
  const tokens = [];
  const protectedPattern = /<span class="notranslate" data-xtr-token="(\d+)">([\s\S]*?)<\/span>/g;
  let text = String(html).replace(protectedPattern, (match, id) => {
    const marker = `__XTR${id}__`;
    tokens.push({ id: String(id), marker, html: match });
    return marker;
  });

  text = text
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  return { text: decodeHtml(text), tokens };
}

function restoreProtectedTokens(translatedText, tokens) {
  let html = escapeHtml(translatedText).replace(/\r\n?|\n/g, "<br/>");

  for (const token of tokens) {
    const markerPattern = new RegExp(`__\\s*XTR\\s*${escapeRegExp(token.id)}\\s*__`, "gi");
    if (!markerPattern.test(html)) {
      throw codedError(
        "BING_FORMAT_ERROR",
        "Bing изменил защищённые ссылки или упоминания в переводе.",
      );
    }
    markerPattern.lastIndex = 0;
    html = html.replace(markerPattern, token.html);
  }

  return `<div>${html}</div>`;
}

function splitBingText(text, limit) {
  if (text.length <= limit) return [{ text, separator: "" }];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      const space = text.lastIndexOf(" ", end);
      const boundary = Math.max(newline, space);
      if (boundary > start + Math.floor(limit * 0.55)) end = boundary + 1;
    }

    const raw = text.slice(start, end);
    const trailing = raw.match(/\s+$/u)?.[0] || "";
    const content = trailing ? raw.slice(0, -trailing.length) : raw;
    if (content) chunks.push({ text: content, separator: trailing });
    else if (trailing) chunks.push({ text: trailing, separator: "" });
    start = end;
  }

  return chunks;
}

async function translateBingText(text, targetLanguage) {
  if (Date.now() < bingBlockedUntil) {
    throw rateLimitError(bingBlockedUntil - Date.now());
  }

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const session = await getBingSession(attempt > 0 && lastError?.code === "BING_SESSION_INVALID");
      return await requestBingTranslation(session, text, targetLanguage);
    } catch (error) {
      lastError = error;
      if (error?.code === "BING_RATE_LIMIT") throw error;
      if (error?.code === "BING_SESSION_INVALID" && attempt === 0) {
        invalidateBingSession();
        continue;
      }
      if (error?.code === "BING_RETRYABLE" && attempt === 0) {
        await delay(500);
        continue;
      }
      throw error;
    }
  }

  throw lastError || codedError("BING_ERROR", "Bing не вернул перевод.");
}

async function getBingSession(forceRefresh = false) {
  if (Date.now() < bingBlockedUntil) {
    throw rateLimitError(bingBlockedUntil - Date.now());
  }
  if (!forceRefresh && bingSession && bingSession.expiresAt > Date.now()) {
    return bingSession;
  }
  if (sessionPromise) return sessionPromise;

  sessionPromise = createBingSession()
    .then((session) => {
      bingSession = session;
      return session;
    })
    .finally(() => {
      sessionPromise = null;
    });
  return sessionPromise;
}

async function createBingSession() {
  const response = await fetchWithTimeout(BING_HOME_URL, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
    headers: { Accept: "text/html,application/xhtml+xml" },
  });

  if (response.status === 429) {
    applyRateLimit(response);
    throw rateLimitError(bingBlockedUntil - Date.now());
  }
  if (!response.ok) {
    throw codedError(
      response.status >= 500 ? "BING_RETRYABLE" : "BING_BOOTSTRAP_ERROR",
      `Не удалось открыть Bing Translator: HTTP ${response.status}.`,
    );
  }

  const html = await response.text();
  const abuseMatch = html.match(/params_AbusePreventionHelper\s*=\s*(\[[^;]+\])/i);
  const ig = html.match(/\bIG\s*:\s*"([^"]+)"/i)?.[1] || "";
  const richTag = html.match(/<[^>]*\bid=["']rich_tta["'][^>]*>/i)?.[0] || "";
  const iid = richTag.match(/\bdata-iid=["']([^"']+)["']/i)?.[1]
    || html.match(/\bdata-iid=["'](translator\.[^"']+)["']/i)?.[1]
    || "";

  let abuse;
  try {
    abuse = JSON.parse(abuseMatch?.[1] || "");
  } catch {
    abuse = null;
  }

  const key = String(abuse?.[0] ?? "");
  const token = String(abuse?.[1] ?? "");
  if (!key || !token || !ig || !iid) {
    throw codedError(
      "BING_BOOTSTRAP_ERROR",
      "Bing изменил страницу переводчика или показал защитную проверку.",
    );
  }

  return {
    key,
    token,
    ig,
    iid,
    count: 0,
    expiresAt: calculateSessionExpiry(abuse?.[2]),
  };
}

function calculateSessionExpiry(rawExpiry) {
  const now = Date.now();
  const expiry = Number(rawExpiry);
  if (!Number.isFinite(expiry)) return now + SESSION_TTL;
  if (expiry > now + 60_000) return Math.min(expiry - 30_000, now + SESSION_TTL);
  if (expiry > 60_000 && expiry < 24 * 60 * 60_000) {
    return Math.min(now + expiry - 30_000, now + SESSION_TTL);
  }
  return now + SESSION_TTL;
}

async function requestBingTranslation(session, text, targetLanguage) {
  const sfx = session.count;
  session.count += 1;
  const url = new URL(BING_TRANSLATE_URL);
  url.searchParams.set("isVertical", "1");
  url.searchParams.set("IG", session.ig);
  url.searchParams.set("IID", session.iid);
  url.searchParams.set("SFX", String(sfx));

  const body = new URLSearchParams({
    fromLang: "auto-detect",
    text,
    to: targetLanguage,
    token: session.token,
    key: session.key,
  });

  const response = await fetchWithTimeout(url, {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: body.toString(),
  });

  if (response.status === 429) {
    applyRateLimit(response);
    throw rateLimitError(bingBlockedUntil - Date.now());
  }
  if (response.status === 401 || response.status === 403) {
    throw codedError("BING_SESSION_INVALID", "Временная сессия Bing истекла.");
  }
  if (!response.ok) {
    throw codedError(
      response.status >= 500 ? "BING_RETRYABLE" : "BING_ERROR",
      `Bing Translator вернул HTTP ${response.status}.`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw codedError(
      "BING_RESPONSE_ERROR",
      "Bing вернул неожиданный ответ вместо перевода.",
    );
  }

  const entry = Array.isArray(payload) ? payload[0] : payload;
  if (Number(entry?.statusCode) === 429) {
    bingBlockedUntil = Date.now() + DEFAULT_RATE_LIMIT_PAUSE;
    throw rateLimitError(DEFAULT_RATE_LIMIT_PAUSE);
  }
  if (entry?.errorMessage) {
    const error = codedError("BING_SESSION_INVALID", String(entry.errorMessage));
    throw error;
  }
  if (Object.prototype.hasOwnProperty.call(entry || {}, "ShowCaptcha")) {
    bingBlockedUntil = Date.now() + DEFAULT_RATE_LIMIT_PAUSE;
    throw rateLimitError(DEFAULT_RATE_LIMIT_PAUSE);
  }

  const translated = entry?.translations?.[0]?.text;
  if (typeof translated !== "string" || !translated.trim()) {
    throw codedError("BING_RESPONSE_ERROR", "Bing вернул пустой перевод.");
  }

  return {
    text: translated,
    detectedLanguage: entry?.detectedLanguage?.language || "",
  };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw codedError("BING_TIMEOUT", "Bing Translator не ответил за 15 секунд.");
    }
    throw codedError("BING_NETWORK_ERROR", "Не удалось подключиться к Bing Translator.");
  } finally {
    clearTimeout(timeout);
  }
}

function applyRateLimit(response) {
  const retryAfter = Number(response.headers?.get?.("Retry-After"));
  const pause = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : DEFAULT_RATE_LIMIT_PAUSE;
  bingBlockedUntil = Date.now() + pause;
}

function rateLimitError(retryAfterMs) {
  const error = codedError(
    "BING_RATE_LIMIT",
    "Bing временно ограничил запросы. Расширение поставило перевод на паузу.",
  );
  error.retryAfterMs = Math.max(1_000, Number(retryAfterMs || DEFAULT_RATE_LIMIT_PAUSE));
  return error;
}

function invalidateBingSession() {
  bingSession = null;
  sessionPromise = null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function decodeHtml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function friendlyError(error) {
  return String(error?.message || "Не удалось выполнить перевод через Bing.");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cacheKey(targetLanguage, html) {
  const bytes = new TextEncoder().encode(`bing\u0000${targetLanguage}\u0000${html}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getCache() {
  if (!cachePromise) {
    cachePromise = chrome.storage.local.get(CACHE_KEY).then((stored) => {
      const entries = Array.isArray(stored[CACHE_KEY]) ? stored[CACHE_KEY] : [];
      return new Map(entries.filter((entry) => Array.isArray(entry) && entry.length === 2));
    });
  }
  return cachePromise;
}

function trimCache(cache) {
  if (cache.size <= CACHE_LIMIT) return;
  const oldest = [...cache.entries()]
    .sort((left, right) => (left[1]?.accessedAt || 0) - (right[1]?.accessedAt || 0))
    .slice(0, cache.size - CACHE_LIMIT);
  oldest.forEach(([key]) => cache.delete(key));
}

async function persistCache(cache) {
  await chrome.storage.local.set({ [CACHE_KEY]: [...cache.entries()] });
}

function updateStats(delta) {
  statsQueue = statsQueue.then(async () => {
    const stored = await chrome.storage.local.get(STATS_KEY);
    const current = stored[STATS_KEY] || {};
    const next = {
      total: Number(current.total || 0) + Number(delta.total || 0),
      cacheHits: Number(current.cacheHits || 0) + Number(delta.cacheHits || 0),
      characters: Number(current.characters || 0) + Number(delta.characters || 0),
      errors: Number(current.errors || 0) + Number(delta.errors || 0),
    };
    await chrome.storage.local.set({ [STATS_KEY]: next });
  });
  return statsQueue;
}
