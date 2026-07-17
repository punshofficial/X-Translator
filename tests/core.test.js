"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const core = context.XTranslatorCore;

test("languagesMatch compares base language codes", () => {
  assert.equal(core.languagesMatch("ru-RU", "ru"), true);
  assert.equal(core.languagesMatch("en", "ru"), false);
  assert.equal(core.languagesMatch("", "ru"), false);
});

test("canReuseTranslationView keeps simultaneous modal copies independent", () => {
  assert.equal(core.canReuseTranslationView({
    sameContainer: false,
    samePost: true,
    sourceConnected: true,
  }), false);
  assert.equal(core.canReuseTranslationView({
    sameContainer: false,
    samePost: true,
    sourceConnected: false,
  }), true);
  assert.equal(core.canReuseTranslationView({
    sameContainer: true,
    samePost: true,
    sourceConnected: true,
  }), true);
  assert.equal(core.canReuseTranslationView({
    sameContainer: false,
    samePost: false,
    sourceConnected: false,
  }), false);
});

test("escapeHtml makes Translator HTML payload safe", () => {
  assert.equal(core.escapeHtml('<a title="x">Tom & Jerry</a>'), "&lt;a title=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;");
});

test("normalizePlainText preserves line breaks while normalizing spacing", () => {
  assert.equal(core.normalizePlainText("  first  \r\n second\tpart  "), "first\nsecond part");
});

test("isProtectedToken recognizes links, mentions, hashtags and cashtags", () => {
  for (const value of ["https://example.com/a", "@user_1", "#Привет", "$MSFT"]) {
    assert.equal(core.isProtectedToken(value), true, value);
  }
  assert.equal(core.isProtectedToken("ordinary text"), false);
});
