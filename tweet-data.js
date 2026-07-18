(function initTweetData(global) {
  "use strict";

  const VERSION = 1;
  const EVENT_NAME = "x-translator:tweet-data";
  const MAX_RECORDS = 400;
  const MAX_TEXT_LENGTH = 100000;
  const MAX_ENTITIES = 500;
  const ID_PATTERN = /^\d{1,30}$/;

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
    if (typeof value !== "string" || value.length > 4096) return "";
    if (!/^https:\/\//i.test(value)) return "";
    try {
      if (typeof URL === "function") {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) return "";
      }
      return value;
    } catch {
      return "";
    }
  }

  function sanitizeRecord(value) {
    if (!value || typeof value !== "object") return null;
    const id = safeId(value.id);
    if (!id || typeof value.text !== "string" || !value.text || value.text.length > MAX_TEXT_LENGTH) {
      return null;
    }
    const displayRange = value.displayRange == null ? null : safeIndices(value.displayRange);
    const entities = [];
    if (Array.isArray(value.entities)) {
      for (const entity of value.entities.slice(0, MAX_ENTITIES)) {
        if (!entity || typeof entity !== "object") continue;
        const type = ["url", "media", "mention", "hashtag", "cashtag"].includes(entity.type)
          ? entity.type
          : "";
        const indices = safeIndices(entity.indices);
        if (!type || !indices) continue;
        const raw = String(entity.raw || "").slice(0, 2048);
        if (!raw) continue;
        entities.push({
          type,
          indices,
          raw,
          display: String(entity.display || raw).slice(0, 2048),
          href: safeUrl(entity.href),
        });
      }
    }
    entities.sort((a, b) => a.indices[0] - b.indices[0] || a.indices[1] - b.indices[1]);
    return {
      id,
      text: value.text,
      lang: String(value.lang || "").slice(0, 32),
      textSource: value.textSource === "note" ? "note" : "legacy",
      displayRange,
      entities,
      quotedId: safeId(value.quotedId),
    };
  }

  function sanitizeTweetDataEnvelope(value) {
    const envelope = value && typeof value === "object" ? value : {};
    const records = [];
    if (Array.isArray(envelope.records)) {
      for (const record of envelope.records.slice(0, MAX_RECORDS)) {
        const sanitized = sanitizeRecord(record);
        if (sanitized) records.push(sanitized);
      }
    }
    return {
      version: VERSION,
      operation: String(envelope.operation || "unknown").replace(/[^A-Za-z0-9_]/g, "").slice(0, 100),
      records,
    };
  }

  global.XTranslatorTweetData = Object.freeze({
    VERSION,
    EVENT_NAME,
    sanitizeTweetDataEnvelope,
  });
})(globalThis);
