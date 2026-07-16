(function exposeCore(global) {
  "use strict";

  function normalizeLanguage(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/_/g, "-");
  }

  function languagesMatch(left, right) {
    const a = normalizeLanguage(left);
    const b = normalizeLanguage(right);
    if (!a || !b) return false;
    return a === b || a.split("-")[0] === b.split("-")[0];
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizePlainText(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\t\f\v ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  function isProtectedToken(value) {
    return /^(?:https?:\/\/|www\.)\S+$/iu.test(value)
      || /^@[\p{L}\p{N}_]+$/u.test(value)
      || /^#[\p{L}\p{N}_]+$/u.test(value)
      || /^\$[A-Z][A-Z0-9_]*$/u.test(value);
  }

  global.XTranslatorCore = Object.freeze({
    escapeHtml,
    isProtectedToken,
    languagesMatch,
    normalizeLanguage,
    normalizePlainText,
  });
})(globalThis);
