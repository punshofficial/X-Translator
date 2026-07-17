"use strict";

const DEFAULTS = {
  enabled: true,
  translationStatsV1: { total: 0, cacheHits: 0, characters: 0, errors: 0 },
};

const enabled = document.getElementById("enabled");
const testButton = document.getElementById("testButton");
const clearCacheButton = document.getElementById("clearCache");
const status = document.getElementById("status");
const serviceTitle = document.getElementById("serviceTitle");
const serviceDescription = document.getElementById("serviceDescription");
const readyDot = document.getElementById("readyDot");
let statusTimer = null;

load();

async function load() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  enabled.checked = settings.enabled !== false;
  renderServiceState();
  renderStats(settings.translationStatsV1);
}

enabled.addEventListener("change", async () => {
  renderServiceState();
  hideStatus();
  await chrome.storage.local.set({ enabled: enabled.checked });
});

testButton.addEventListener("click", async () => {
  setBusy(true);
  showStatus("Проверяю перевод…", "loading");
  try {
    const response = await chrome.runtime.sendMessage({ type: "TEST_TRANSLATOR" });
    if (!response?.ok) throw new Error(displayTranslationError(response));
    showStatus(`Перевод работает: ${response.translatedText}`, "success");
  } catch (error) {
    showStatus(error.message || "Сервис перевода временно недоступен.", "error");
  } finally {
    setBusy(false);
  }
});

clearCacheButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
  showStatus(response?.ok ? "Кэш очищен." : "Не удалось очистить кэш.", response?.ok ? "success" : "error");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.translationStatsV1) {
    renderStats(changes.translationStatsV1.newValue);
  }
});

function renderStats(stats = {}) {
  const total = Number(stats.total || 0);
  const cacheHits = Number(stats.cacheHits || 0);
  const cacheRate = total > 0 ? Math.round((cacheHits / total) * 100) : 0;
  document.getElementById("statTotal").textContent = formatNumber(total);
  document.getElementById("statCacheRate").textContent = `${cacheRate}%`;
  document.getElementById("statCache").textContent = `${formatNumber(cacheHits)} мгновенно`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("ru-RU", { notation: Number(value) > 99_999 ? "compact" : "standard" })
    .format(Number(value || 0));
}

function showStatus(message, type = "") {
  if (statusTimer !== null) clearTimeout(statusTimer);
  status.className = `status ${type}`.trim();
  status.textContent = message;
  status.hidden = false;
  if (type !== "loading") {
    statusTimer = setTimeout(hideStatus, 5_000);
  }
}

function setBusy(value) {
  testButton.disabled = value;
  testButton.textContent = value ? "Проверяю…" : "Проверить";
}

function hideStatus() {
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusTimer = null;
  status.hidden = true;
  status.textContent = "";
  status.className = "status";
}

function renderServiceState() {
  const active = enabled.checked;
  serviceTitle.textContent = active ? "Автоперевод включён" : "Автоперевод выключен";
  serviceDescription.textContent = active ? "Посты, ответы и цитаты" : "Посты остаются без изменений";
  readyDot.classList.toggle("off", !active);
}

function displayTranslationError(response) {
  if (response?.code === "BING_RATE_LIMIT") {
    return "Слишком много запросов. Перевод возобновится автоматически.";
  }
  if (response?.code === "DISABLED") return "Сначала включите автоперевод.";
  return "Сервис перевода временно недоступен.";
}
