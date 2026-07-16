"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.join(__dirname, "..");
const sharedSource = fs.readFileSync(path.join(root, "shared.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");

const SESSION_HTML = `
  <html>
    <script>
      var params_AbusePreventionHelper = [1234567890,"anonymous-token",3600000];
      var config = { IG:"TEST-IG" };
    </script>
    <div id="rich_tta" data-iid="translator.5028"></div>
  </html>
`;

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    async text() { return body; },
  };
}

function defaultFetch(url, options = {}) {
  const href = String(url);
  if (href.endsWith("/translator")) return response(200, SESSION_HTML);

  const form = new URLSearchParams(options.body);
  const translated = form.get("text")
    .replace("Hello", "Привет")
    .replace("world", "мир");
  return response(200, JSON.stringify([{
    detectedLanguage: { language: "en", score: 1 },
    translations: [{ text: translated, to: "ru" }],
  }]));
}

function createBackground(initialStorage = {}, fetchImpl = defaultFetch) {
  const values = { ...initialStorage };
  const fetchCalls = [];
  let messageListener;

  const local = {
    async get(query) {
      if (typeof query === "string") return { [query]: values[query] };
      if (Array.isArray(query)) return Object.fromEntries(query.map((key) => [key, values[key]]));
      return Object.fromEntries(Object.entries(query || {}).map(([key, fallback]) => [
        key,
        Object.hasOwn(values, key) ? values[key] : fallback,
      ]));
    },
    async set(patch) { Object.assign(values, patch); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };

  const context = vm.createContext({
    AbortController,
    TextEncoder,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    crypto: webcrypto,
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      return fetchImpl(url, options, fetchCalls.length);
    },
    importScripts() { vm.runInContext(sharedSource, context); },
    setTimeout,
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(listener) { messageListener = listener; } },
      },
      storage: { local },
    },
  });

  vm.runInContext(backgroundSource, context);

  return {
    values,
    fetchCalls,
    send(message) {
      return new Promise((resolve) => messageListener(message, {}, resolve));
    },
  };
}

test("background bootstraps an anonymous Bing session without a user key", async () => {
  const background = createBackground({ enabled: true });
  const responseValue = await background.send({
    type: "TRANSLATE_BATCH",
    items: [{ id: "1", html: "<div>Hello</div>", plainText: "Hello" }],
  });

  assert.equal(responseValue.ok, true);
  assert.match(responseValue.results[0].translatedHtml, /Привет/);
  assert.equal(responseValue.results[0].detectedLanguage, "en");
  assert.equal(background.fetchCalls.length, 2);
  assert.match(background.fetchCalls[0].url, /bing\.com\/translator$/);
  assert.match(background.fetchCalls[1].url, /bing\.com\/ttranslatev3/);

  const requestUrl = new URL(background.fetchCalls[1].url);
  assert.equal(requestUrl.searchParams.get("IID"), "translator.5028");
  assert.equal(requestUrl.searchParams.get("SFX"), "0");

  const form = new URLSearchParams(background.fetchCalls[1].options.body);
  assert.equal(form.get("key"), "1234567890");
  assert.equal(form.get("token"), "anonymous-token");
  assert.equal(form.get("fromLang"), "auto-detect");
  assert.equal(form.get("to"), "ru");
});

test("background auto-detects languages other than English", async () => {
  const background = createBackground({ enabled: true }, (url, options = {}) => {
    if (String(url).endsWith("/translator")) return response(200, SESSION_HTML);

    const form = new URLSearchParams(options.body);
    assert.equal(form.get("fromLang"), "auto-detect");
    assert.equal(form.get("text"), "Hola");
    return response(200, JSON.stringify([{
      detectedLanguage: { language: "es" },
      translations: [{ text: "Привет", to: "ru" }],
    }]));
  });

  const result = await background.send({
    type: "TRANSLATE_BATCH",
    items: [{ id: "es-1", html: "<div>Hola</div>", plainText: "Hola" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].detectedLanguage, "es");
  assert.match(result.results[0].translatedHtml, /Привет/);
});

test("background preserves protected tokens, line breaks, cache and item ids", async () => {
  const background = createBackground({ enabled: true, targetLanguage: "ru" });
  const message = {
    type: "TRANSLATE_BATCH",
    items: [{
      id: "post-7",
      html: "<div>Hello <span class=\"notranslate\" data-xtr-token=\"0\">@x</span><br/>world</div>",
      plainText: "Hello @x\nworld",
    }],
  };

  const first = await background.send(message);
  const second = await background.send(message);

  assert.equal(first.ok, true);
  assert.equal(first.results[0].id, "post-7");
  assert.match(first.results[0].translatedHtml, /Привет/);
  assert.match(first.results[0].translatedHtml, /data-xtr-token="0">@x<\/span>/);
  assert.match(first.results[0].translatedHtml, /<br\/>мир/);
  assert.equal(first.results[0].cached, false);
  assert.equal(second.results[0].cached, true);
  assert.equal(background.fetchCalls.length, 2);
  assert.equal(background.values.translationStatsV1.total, 2);
  assert.equal(background.values.translationStatsV1.cacheHits, 1);
});

test("background refreshes an expired Bing session once", async () => {
  let bootstrapCount = 0;
  let postCount = 0;
  const background = createBackground({ enabled: true }, (url, options = {}) => {
    if (String(url).endsWith("/translator")) {
      bootstrapCount += 1;
      return response(200, SESSION_HTML.replace("anonymous-token", `token-${bootstrapCount}`));
    }
    postCount += 1;
    if (postCount === 1) return response(403, "expired");
    const form = new URLSearchParams(options.body);
    return response(200, JSON.stringify([{
      detectedLanguage: { language: "en" },
      translations: [{ text: form.get("text").replace("Hello", "Привет") }],
    }]));
  });

  const result = await background.send({
    type: "TRANSLATE_BATCH",
    items: [{ id: "1", html: "<div>Hello</div>", plainText: "Hello" }],
  });

  assert.equal(result.ok, true);
  assert.equal(bootstrapCount, 2);
  assert.equal(postCount, 2);
});

test("background pauses after Bing rate limiting instead of retrying", async () => {
  const background = createBackground({ enabled: true }, (url) => {
    if (String(url).endsWith("/translator")) return response(200, SESSION_HTML);
    return response(429, "rate limited", { "Retry-After": "120" });
  });
  const message = {
    type: "TRANSLATE_BATCH",
    items: [{ id: "1", html: "<div>Hello</div>", plainText: "Hello" }],
  };

  const first = await background.send(message);
  const second = await background.send(message);

  assert.equal(first.ok, false);
  assert.equal(first.code, "BING_RATE_LIMIT");
  assert.ok(first.retryAfterMs >= 119_000);
  assert.equal(second.code, "BING_RATE_LIMIT");
  assert.equal(background.fetchCalls.length, 2);
});
