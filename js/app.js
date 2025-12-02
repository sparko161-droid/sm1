// app.js
// Главный модуль SPA для графика смен L1/L2
// Чистый vanilla JS.

/**
 * Основные сущности:
 * - Авторизация через n8n /graph (type: "auth")
 * - Pyrus API через n8n /graph (type: "pyrus_api")
 * - Кеширование данных смен в памяти
 * - UI: таблица, ховер строки, анимация ячеек, компактный поповер смены
 * - Система прав доступа: edit/view для L1 и L2
 */

const GRAPH_HOOK_URL = "https://jolikcisout.beget.app/webhook/pyrus/graph";
const MAX_DAYS_IN_MONTH = 31;
const LOCAL_TZ_OFFSET_MIN = 4 * 60; // GMT+4

// Универсальный helper для n8n-обёртки Pyrus { success, data }
function unwrapPyrusData(raw) {
  if (
    raw &&
    typeof raw === "object" &&
    Object.prototype.hasOwnProperty.call(raw, "data") &&
    Object.prototype.hasOwnProperty.call(raw, "success")
  ) {
    return raw.data;
  }
  return raw;
}

// -----------------------------
// Глобальное состояние
// -----------------------------

const state = {
  auth: {
    user: null,
    permissions: {
      L1: "view",
      L2: "view",
    },
  },
  ui: {
    currentLine: "L1",
    theme: "dark",
  },
  quickMode: {
    enabled: false,
    templateId: null,
    timeFrom: "",
    timeTo: "",
    amount: "",
  },
  employeesByLine: {
    L1: [],
    L2: [],
  },
  shiftTemplatesByLine: {
    L1: [],
    L2: [],
  },
  scheduleByLine: {
    L1: { monthKey: null, days: [], rows: [] },
    L2: { monthKey: null, days: [], rows: [] },
  },
  originalScheduleByLine: {
    L1: { monthKey: null, days: [], rows: [] },
    L2: { monthKey: null, days: [], rows: [] },
  },
  localChanges: {},
  changeHistory: [],
  monthMeta: {
    year: null,
    monthIndex: null,
  },
};

const scheduleCacheByLine = {
  L1: Object.create(null),
  L2: Object.create(null),
};

const STORAGE_KEYS = {
  localChanges: "sm1_local_changes",
  changeHistory: "sm1_change_history",
  theme: "sm1_theme_preference",
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// -----------------------------
// Проверка прав доступа
// -----------------------------

function canEditLine(line) {
  const permission = state.auth.permissions[line];
  return permission === "edit";
}

function canViewLine(line) {
  const permission = state.auth.permissions[line];
  return permission === "view" || permission === "edit";
}

function getCurrentLinePermission() {
  return state.auth.permissions[state.ui.currentLine];
}

// -----------------------------
// Утилиты времени
// -----------------------------

function parseShiftTimeRangeString(raw) {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/\s+/g, "");
  const [startRaw, endRaw] = cleaned.split("-");
  if (!startRaw || !endRaw) return null;

  const norm = (part) => {
    const withColon = part.replace(".", ":");
    const [hStr, mStr = "00"] = withColon.split(":");
    const h = String(parseInt(hStr, 10)).padStart(2, "0");
    const m = String(parseInt(mStr, 10)).padStart(2, "0");
    return `${h}:${m}`;
  };

  return { start: norm(startRaw), end: norm(endRaw) };
}

function addMinutesLocal(baseMinutes, delta) {
  let total = baseMinutes + delta;
  let dayShift = 0;
  while (total < 0) {
    total += 24 * 60;
    dayShift -= 1;
  }
  while (total >= 24 * 60) {
    total -= 24 * 60;
    dayShift += 1;
  }
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return { time: `${hh}:${mm}`, dayShift };
}

function convertUtcStartToLocalRange(utcIsoString, durationMinutes) {
  if (!utcIsoString || typeof utcIsoString !== "string") return null;
  const startUtc = new Date(utcIsoString);
  if (Number.isNaN(startUtc.getTime())) return null;

  const startLocalMs =
    startUtc.getTime() + LOCAL_TZ_OFFSET_MIN * 60 * 1000;
  const startLocalDate = new Date(startLocalMs);

  const startHH = String(startLocalDate.getUTCHours()).padStart(2, "0");
  const startMM = String(startLocalDate.getUTCMinutes()).padStart(2, "0");
  const startLocal = `${startHH}:${startMM}`;

  const startMinutes =
    startLocalDate.getUTCHours() * 60 + startLocalDate.getUTCMinutes();
  const { time: endLocal } = addMinutesLocal(
    startMinutes,
    durationMinutes || 0
  );

  const y = startLocalDate.getUTCFullYear();
  const m = String(startLocalDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(startLocalDate.getUTCDate()).padStart(2, "0");

  return {
    localDateKey: `${y}-${m}-${d}`,
    startLocal,
    endLocal,
  };
}

function formatShiftTimeForCell(startLocal, endLocal) {
  return { start: startLocal, end: endLocal };
}

function parseTimeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const [hh, mm] = hhmm.split(":").map((p) => Number(p));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}

function computeDurationMinutes(startLocal, endLocal) {
  const start = parseTimeToMinutes(startLocal);
  const end = parseTimeToMinutes(endLocal);
  if (start == null || end == null) return null;
  let diff = end - start;
  if (diff <= 0) diff += 24 * 60;
  return diff;
}

function convertLocalRangeToUtc(day, startLocal, endLocal) {
  const durationMinutes = computeDurationMinutes(startLocal, endLocal);
  if (durationMinutes == null) return null;

  const { year, monthIndex } = state.monthMeta;
  const [hh, mm] = (startLocal || "00:00").split(":");

  const startUtcMs =
    Date.UTC(year, monthIndex, day, Number(hh), Number(mm)) -
    LOCAL_TZ_OFFSET_MIN * 60 * 1000;
  const endUtcMs = startUtcMs + durationMinutes * 60 * 1000;

  return {
    durationMinutes,
    startUtcIso: new Date(startUtcMs).toISOString(),
    endUtcIso: new Date(endUtcMs).toISOString(),
  };
}

// -----------------------------
// API-слой
// -----------------------------

async function callGraphApi(type, payload) {
  if (!type) {
    throw new Error("callGraphApi: не указан тип хука");
  }

  const res = await fetch(GRAPH_HOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...payload }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ошибка HTTP ${res.status}: ${res.statusText || ""}\n${text}`
    );
  }

  return res.json();
}

async function auth(login, password) {
  const result = await callGraphApi("auth", { login, password });

  if (!result || result.status !== "ACCESS_GRANTED") {
    throw new Error("Доступ запрещён (status != ACCESS_GRANTED)");
  }

  state.auth.user = result.user || null;
  state.auth.permissions = result.permissions || { L1: "view", L2: "view" };
  return result;
}

async function pyrusApi(path, method = "GET", body = null) {
  const payload = { path, method };
  if (body) payload.body = body;
  return callGraphApi("pyrus_api", payload);
}

// -----------------------------
// DOM-ссылки
// -----------------------------

const $ = (sel) => document.querySelector(sel);

const loginScreenEl = $("#login-screen");
const mainScreenEl = $("#main-screen");

const loginFormEl = $("#login-form");
const loginInputEl = $("#login-input");
const passwordInputEl = $("#password-input");
const loginErrorEl = $("#login-error");
const loginButtonEl = $("#login-button");

const currentUserLabelEl = $("#current-user-label");
const currentMonthLabelEl = $("#current-month-label");

const btnLineL1El = $("#btn-line-l1");
const btnLineL2El = $("#btn-line-l2");
const btnPrevMonthEl = $("#btn-prev-month");
const btnNextMonthEl = $("#btn-next-month");
const btnThemeToggleEl = $("#btn-theme-toggle");
const btnSavePyrusEl = $("#btn-save-pyrus");

const scheduleRootEl = $("#schedule-root");
const quickTemplateSelectEl = $("#quick-template-select");
const quickTimeFromInputEl = $("#quick-time-from");
const quickTimeToInputEl = $("#quick-time-to");
const quickAmountInputEl = $("#quick-amount");
const quickModeToggleEl = $("#quick-mode-toggle");
const changeLogListEl = $("#change-log-list");
const btnClearHistoryEl = $("#btn-clear-history");

// поповер смены
let shiftPopoverEl = null;
let shiftPopoverBackdropEl = null;
let shiftPopoverKeydownHandler = null;

// -----------------------------
// Инициализация
// -----------------------------

function init() {
  resetLocalEditingState();
  initTheme();
  initMonthMetaToToday();
  bindLoginForm();
  bindTopBarButtons();
  bindHistoryControls();
  createShiftPopover();
  renderChangeLog();
}

function getCurrentLineTemplates() {
  return state.shiftTemplatesByLine[state.ui.currentLine] || [];
}

function initMonthMetaToToday() {
  const now = new Date();
  state.monthMeta.year = now.getFullYear();
  state.monthMeta.monthIndex = now.getMonth();
  updateMonthLabel();
}

function updateMonthLabel() {
  const { year, monthIndex } = state.monthMeta;
  const monthNames = [
    "Январь",
    "Февраль",
    "Март",
    "Апрель",
    "Май",
    "Июнь",
    "Июль",
    "Август",
    "Сентябрь",
    "Октябрь",
    "Ноябрь",
    "Декабрь",
  ];
  currentMonthLabelEl.textContent = `${monthNames[monthIndex]} ${year}`;
}

function resetLocalEditingState() {
  state.localChanges = {};
  state.changeHistory = [];

  try {
    localStorage.removeItem(STORAGE_KEYS.localChanges);
    localStorage.removeItem(STORAGE_KEYS.changeHistory);
  } catch (err) {
    console.warn("Не удалось сбросить локальные данные", err);
  }
}

function persistLocalChanges() {
  try {
    localStorage.setItem(STORAGE_KEYS.localChanges, JSON.stringify(state.localChanges));
  } catch (err) {
    console.warn("Не удалось сохранить локальные смены", err);
  }
}

function persistChangeHistory() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.changeHistory,
      JSON.stringify(state.changeHistory.slice(0, 300))
    );
  } catch (err) {
    console.warn("Не удалось сохранить историю", err);
  }
}

function initTheme() {
  const storedTheme = localStorage.getItem(STORAGE_KEYS.theme);
  const preferredTheme = storedTheme === "light" ? "light" : "dark";
  applyTheme(preferredTheme);

  if (btnThemeToggleEl) {
    btnThemeToggleEl.addEventListener("click", () => {
      const next = state.ui.theme === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  }
}

function applyTheme(theme) {
  state.ui.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEYS.theme, theme);
  updateThemeToggleUI();
}

function updateThemeToggleUI() {
  if (!btnThemeToggleEl) return;
  const isDark = state.ui.theme === "dark";
  btnThemeToggleEl.textContent = isDark ? "🌙 Тема" : "☀️ Тема";
  btnThemeToggleEl.setAttribute(
    "aria-label",
    isDark ? "Включена тёмная тема" : "Включена светлая тема"
  );
}

// -----------------------------
// События
// -----------------------------

function bindLoginForm() {
  const handleLogin = async (e) => {
    e.preventDefault();
    loginErrorEl.textContent = "";

    if (!loginFormEl) return;
    const btn = loginFormEl.querySelector("button[type=submit]") || loginButtonEl;
    if (btn) btn.disabled = true;

    const login = loginInputEl.value.trim();
    const password = passwordInputEl.value;

    try {
      const authResult = await auth(login, password);
      currentUserLabelEl.textContent = `${
        authResult.user?.name || ""
      } (${login})`;

      loginScreenEl.classList.add("hidden");
      mainScreenEl.classList.remove("hidden");

      await loadInitialData();
    } catch (err) {
      console.error("Auth error:", err);
      loginErrorEl.textContent = err.message || "Ошибка авторизации";
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  loginFormEl?.addEventListener("submit", handleLogin);
  loginButtonEl?.addEventListener("click", handleLogin);
}

function bindTopBarButtons() {
  btnLineL1El.addEventListener("click", () => {
    state.ui.currentLine = "L1";
    updateLineToggleUI();
    updateSaveButtonState();
    updateQuickModeForLine();
    renderQuickTemplateOptions();
    renderScheduleCurrentLine();
  });

  btnLineL2El.addEventListener("click", () => {
    state.ui.currentLine = "L2";
    updateLineToggleUI();
    updateSaveButtonState();
    updateQuickModeForLine();
    renderQuickTemplateOptions();
    renderScheduleCurrentLine();
  });

  btnPrevMonthEl.addEventListener("click", () => {
    const { year, monthIndex } = state.monthMeta;
    const date = new Date(Date.UTC(year, monthIndex, 1));
    date.setMonth(monthIndex - 1);
    state.monthMeta.year = date.getUTCFullYear();
    state.monthMeta.monthIndex = date.getUTCMonth();
    updateMonthLabel();
    reloadScheduleForCurrentMonth();
  });

  btnNextMonthEl.addEventListener("click", () => {
    const { year, monthIndex } = state.monthMeta;
    const date = new Date(Date.UTC(year, monthIndex, 1));
    date.setMonth(monthIndex + 1);
    state.monthMeta.year = date.getUTCFullYear();
    state.monthMeta.monthIndex = date.getUTCMonth();
    updateMonthLabel();
    reloadScheduleForCurrentMonth();
  });

  updateLineToggleUI();
}

function updateLineToggleUI() {
  const line = state.ui.currentLine;
  if (line === "L1") {
    btnLineL1El.classList.add("active");
    btnLineL2El.classList.remove("active");
  } else {
    btnLineL1El.classList.remove("active");
    btnLineL2El.classList.add("active");
  }
}

function bindHistoryControls() {
  if (btnClearHistoryEl) {
    btnClearHistoryEl.addEventListener("click", () => {
      state.changeHistory = [];
      persistChangeHistory();
      renderChangeLog();
    });
  }

  if (btnSavePyrusEl) {
    btnSavePyrusEl.addEventListener("click", handleSaveToPyrus);
  }
}

function initQuickAssignPanel() {
  renderQuickTemplateOptions();
  syncQuickPanelInputs();
  updateQuickModeToggleUI();

  quickTemplateSelectEl?.addEventListener("change", () => {
    const val = quickTemplateSelectEl.value;
    state.quickMode.templateId = val ? Number(val) : null;

    const tmpl = getCurrentLineTemplates().find(
      (t) => t.id === state.quickMode.templateId
    );
    if (tmpl?.timeRange) {
      state.quickMode.timeFrom = tmpl.timeRange.start;
      state.quickMode.timeTo = tmpl.timeRange.end;
      syncQuickPanelInputs();
    }
    if (tmpl && typeof tmpl.amount === "number") {
      state.quickMode.amount = tmpl.amount;
      syncQuickPanelInputs();
    }
  });

  quickTimeFromInputEl?.addEventListener("input", (e) => {
    state.quickMode.timeFrom = e.target.value;
  });

  quickTimeToInputEl?.addEventListener("input", (e) => {
    state.quickMode.timeTo = e.target.value;
  });

  quickAmountInputEl?.addEventListener("input", (e) => {
    state.quickMode.amount = e.target.value;
  });

  quickModeToggleEl?.addEventListener("click", () => {
    const currentLine = state.ui.currentLine;
    
    if (!canEditLine(currentLine)) {
      alert(`У вас нет прав на редактирование линии ${currentLine}`);
      return;
    }
    
    state.quickMode.enabled = !state.quickMode.enabled;
    updateQuickModeToggleUI();
  });
}

function renderQuickTemplateOptions() {
  if (!quickTemplateSelectEl) return;

  const currentLineTemplates = getCurrentLineTemplates();
  const prevSelected = state.quickMode.templateId;

  quickTemplateSelectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Шаблон не выбран";
  quickTemplateSelectEl.appendChild(placeholder);

  currentLineTemplates.forEach((tmpl) => {
    const option = document.createElement("option");
    option.value = String(tmpl.id);
    const timeLabel = tmpl.timeRange
      ? ` (${tmpl.timeRange.start}–${tmpl.timeRange.end})`
      : "";
    option.textContent = `${tmpl.name}${timeLabel}`;
    quickTemplateSelectEl.appendChild(option);
  });

  const hasPrev = currentLineTemplates.some((t) => t.id === prevSelected);
  quickTemplateSelectEl.value = hasPrev ? String(prevSelected) : "";
  state.quickMode.templateId = hasPrev ? prevSelected : null;
}

function syncQuickPanelInputs() {
  if (quickTimeFromInputEl) {
    quickTimeFromInputEl.value = state.quickMode.timeFrom || "";
  }
  if (quickTimeToInputEl) {
    quickTimeToInputEl.value = state.quickMode.timeTo || "";
  }
  if (quickAmountInputEl) {
    quickAmountInputEl.value =
      state.quickMode.amount !== undefined && state.quickMode.amount !== null
        ? state.quickMode.amount
        : "";
  }
}

function updateQuickModeToggleUI() {
  if (!quickModeToggleEl) return;
  quickModeToggleEl.classList.toggle("active", state.quickMode.enabled);
  quickModeToggleEl.textContent = state.quickMode.enabled
    ? "Быстрое назначение: Вкл"
    : "Быстрое назначение";
}

function updateQuickModeForLine() {
  const currentLine = state.ui.currentLine;
  const canEdit = canEditLine(currentLine);
  
  if (!canEdit && state.quickMode.enabled) {
    state.quickMode.enabled = false;
    updateQuickModeToggleUI();
  }
  
  if (quickModeToggleEl) {
    quickModeToggleEl.disabled = !canEdit;
    quickModeToggleEl.title = canEdit 
      ? "Включить быстрое назначение смен"
      : `Нет прав на редактирование ${currentLine}`;
  }
  
  if (quickTemplateSelectEl) {
    quickTemplateSelectEl.disabled = !canEdit;
  }
  
  if (quickTimeFromInputEl) {
    quickTimeFromInputEl.disabled = !canEdit;
  }
  
  if (quickTimeToInputEl) {
    quickTimeToInputEl.disabled = !canEdit;
  }
  
  if (quickAmountInputEl) {
    quickAmountInputEl.disabled = !canEdit;
  }
}

function countChangesForLine(line) {
  const { year, monthIndex } = state.monthMeta;
  let count = 0;
  
  const prefix = `${line}-${year}-${monthIndex + 1}-`;
  for (const key in state.localChanges) {
    if (key.startsWith(prefix)) {
      count++;
    }
  }
  
  return count;
}

function updateSaveButtonState() {
  if (!btnSavePyrusEl) return;
  
  const currentLine = state.ui.currentLine;
  const canEdit = canEditLine(currentLine);
  const changesCount = countChangesForLine(currentLine);
  
  if (!canEdit) {
    btnSavePyrusEl.textContent = `Нет прав на ${currentLine}`;
    btnSavePyrusEl.disabled = true;
    btnSavePyrusEl.title = `У вас только просмотр для линии ${currentLine}`;
  } else if (changesCount === 0) {
    btnSavePyrusEl.textContent = `Нет изменений (${currentLine})`;
    btnSavePyrusEl.disabled = true;
    btnSavePyrusEl.title = `Нет несохранённых изменений для линии ${currentLine}`;
  } else {
    btnSavePyrusEl.textContent = `Сохранить ${currentLine} (${changesCount})`;
    btnSavePyrusEl.disabled = false;
    btnSavePyrusEl.title = `Сохранить ${changesCount} изменений для линии ${currentLine}`;
  }
}

function getQuickModeShift(line) {
  const templates = state.shiftTemplatesByLine[line] || [];
  const tmpl = templates.find((t) => t.id === state.quickMode.templateId);

  let startLocal = state.quickMode.timeFrom;
  let endLocal = state.quickMode.timeTo;

  if ((!startLocal || !endLocal) && tmpl?.timeRange) {
    startLocal = tmpl.timeRange.start;
    endLocal = tmpl.timeRange.end;
  }

  let amount = state.quickMode.amount;
  if (amount === "" || amount === undefined || amount === null) {
    amount = tmpl?.amount ?? 0;
  }

  return {
    startLocal,
    endLocal,
    amount: Number(amount || 0),
    templateId: tmpl?.id ?? null,
  };
}

function logChange({
  action,
  line,
  employeeId,
  employeeName,
  day,
  previousShift,
  nextShift,
}) {
  const { year, monthIndex } = state.monthMeta;
  const date = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(
    2,
    "0"
  )}`;
  const entry = {
    id: `${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    action,
    line,
    employeeId,
    employeeName,
    date,
    previousShift: previousShift
      ? {
          startLocal: previousShift.startLocal || "",
          endLocal: previousShift.endLocal || "",
          amount: Number(previousShift.amount || 0),
        }
      : null,
    nextShift: nextShift
      ? {
          startLocal: nextShift.startLocal || "",
          endLocal: nextShift.endLocal || "",
          amount: Number(nextShift.amount || 0),
        }
      : null,
  };

  state.changeHistory.unshift(entry);
  if (state.changeHistory.length > 300) {
    state.changeHistory.length = 300;
  }

  persistChangeHistory();
  renderChangeLog();
  updateSaveButtonState();
}

function shiftsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const normalizeAmount = (val) => Number(val || 0);
  const normalizeTemplate = (val) => (val != null ? Number(val) : null);
  const normalizeIso = (iso) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
  };

  const normDuration = (shift) => {
    if (shift?.durationMinutes != null) return Number(shift.durationMinutes);
    const duration = computeDurationMinutes(
      shift?.startLocal,
      shift?.endLocal
    );
    return duration == null ? null : duration;
  };

  return (
    (a.startLocal || "") === (b.startLocal || "") &&
    (a.endLocal || "") === (b.endLocal || "") &&
    normalizeAmount(a.amount) === normalizeAmount(b.amount) &&
    normalizeTemplate(a.templateId) === normalizeTemplate(b.templateId) &&
    normalizeIso(a.startUtcIso) === normalizeIso(b.startUtcIso) &&
    normalizeIso(a.endUtcIso) === normalizeIso(b.endUtcIso) &&
    normDuration(a) === normDuration(b)
  );
}

function buildPyrusChangesPayload(lineToSave = null) {
  const result = {
    create: { task: [] },
    deleted: { task: [] },
    edit: { task: [] },
  };

  const linesToProcess = lineToSave ? [lineToSave] : ["L1", "L2"];

  for (const line of linesToProcess) {
    const baseSched = state.originalScheduleByLine[line];
    const currentSched = state.scheduleByLine[line];
    if (!currentSched || !currentSched.days || !currentSched.rows) continue;

    const baseRowByEmployee = Object.create(null);
    if (baseSched && Array.isArray(baseSched.rows)) {
      for (const row of baseSched.rows) {
        baseRowByEmployee[row.employeeId] = row;
      }
    }

    currentSched.rows.forEach((row) => {
      const baseRow = baseRowByEmployee[row.employeeId];

      currentSched.days.forEach((day, idx) => {
        const baseShift = baseRow ? baseRow.shiftsByDay[idx] || null : null;
        const currentShift = row.shiftsByDay[idx] || null;

        if (!baseShift && !currentShift) return;

        if (!baseShift && currentShift) {
          const conversion =
            currentShift.startUtcIso && currentShift.durationMinutes != null
              ? {
                  startUtcIso: currentShift.startUtcIso,
                  durationMinutes: Number(currentShift.durationMinutes),
                }
              : convertLocalRangeToUtc(
                  day,
                  currentShift.startLocal,
                  currentShift.endLocal
                );
          if (!conversion) return;

          result.create.task.push({
            employee_id: row.employeeId,
            item_id: currentShift.templateId ?? null,
            start: conversion.startUtcIso,
            duration: conversion.durationMinutes,
            amount: Number(currentShift.amount || 0),
          });
          return;
        }

        if (baseShift && !currentShift) {
          if (baseShift.taskId) {
            result.deleted.task.push({ task_id: baseShift.taskId });
          }
          return;
        }

        if (baseShift && currentShift && !shiftsEqual(baseShift, currentShift)) {
          const conversion =
            currentShift.startUtcIso && currentShift.durationMinutes != null
              ? {
                  startUtcIso: currentShift.startUtcIso,
                  durationMinutes: Number(currentShift.durationMinutes),
                }
              : convertLocalRangeToUtc(
                  day,
                  currentShift.startLocal,
                  currentShift.endLocal
                );
          if (!conversion) return;

          result.edit.task.push({
            task_id: baseShift.taskId,
            employee_id: row.employeeId,
            item_id: currentShift.templateId ?? baseShift.templateId ?? null,
            start: conversion.startUtcIso,
            duration: conversion.durationMinutes,
            amount: Number(currentShift.amount || 0),
          });
        }
      });
    });
  }

  return result;
}

async function handleSaveToPyrus() {
  if (!btnSavePyrusEl) return;

  const currentLine = state.ui.currentLine;
  
  if (!canEditLine(currentLine)) {
    alert(`У вас нет прав на сохранение изменений для линии ${currentLine}`);
    return;
  }

  const payload = buildPyrusChangesPayload(currentLine);
  
  const hasChanges = 
    payload.create.task.length > 0 ||
    payload.deleted.task.length > 0 ||
    payload.edit.task.length > 0;
  
  if (!hasChanges) {
    alert(`Нет изменений для сохранения в линии ${currentLine}`);
    return;
  }
  
  btnSavePyrusEl.disabled = true;
  btnSavePyrusEl.textContent = "Сохранение...";

  try {
    const meta = {
      line: currentLine,
      month: state.monthMeta.monthIndex + 1,
      year: state.monthMeta.year,
    };
    
    await callGraphApi("pyrus_save", { changes: payload, meta });
    
    alert(`Изменения для линии ${currentLine} успешно отправлены в Pyrus.\n` +
          `Создано: ${payload.create.task.length}\n` +
          `Изменено: ${payload.edit.task.length}\n` +
          `Удалено: ${payload.deleted.task.length}`);
    
    state.originalScheduleByLine[currentLine] = deepClone(state.scheduleByLine[currentLine]);
    
    const { year, monthIndex } = state.monthMeta;
    const prefix = `${currentLine}-${year}-${monthIndex + 1}-`;
    for (const key in state.localChanges) {
      if (key.startsWith(prefix)) {
        delete state.localChanges[key];
      }
    }
    persistLocalChanges();
    
    updateSaveButtonState();
    
  } catch (err) {
    console.error("handleSaveToPyrus error", err);
    alert(`Не удалось отправить в Pyrus: ${err.message || err}`);
  } finally {
    btnSavePyrusEl.disabled = false;
    btnSavePyrusEl.textContent = "Сохранить в Pyrus";
  }
}

function renderChangeLog() {
  if (!changeLogListEl) return;

  changeLogListEl.innerHTML = "";

  if (!state.changeHistory.length) {
    changeLogListEl.textContent = "Пока нет локальных изменений";
    changeLogListEl.classList.add("change-log-empty");
    return;
  }

  changeLogListEl.classList.remove("change-log-empty");
  const actionLabels = {
    create: "Добавлена смена",
    update: "Изменена смена",
    delete: "Удалена смена",
  };

  const formatShift = (shift) => {
    if (!shift) return "—";
    const amountLabel = shift.amount ? `${shift.amount.toLocaleString("ru-RU")} ₽` : "";
    return `${shift.startLocal}–${shift.endLocal}${amountLabel ? ` · ${amountLabel}` : ""}`;
  };

  state.changeHistory.forEach((entry) => {
    const wrapper = document.createElement("div");
    wrapper.className = "change-log-entry";

    const title = document.createElement("div");
    const actionLabel = actionLabels[entry.action] || "Изменение";
    const time = new Date(entry.timestamp).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    title.textContent = `${actionLabel} • ${entry.date} • ${time}`;

    const details = document.createElement("div");
    details.textContent = `${entry.employeeName} (${entry.line})`;

    const shiftLine = document.createElement("div");
    shiftLine.textContent = `Было: ${formatShift(entry.previousShift)} → Стало: ${formatShift(
      entry.nextShift
    )}`;

    wrapper.appendChild(title);
    wrapper.appendChild(details);
    wrapper.appendChild(shiftLine);
    changeLogListEl.appendChild(wrapper);
  });
}

function handleShiftCellClick({ line, row, day, dayIndex, shift, cellEl }) {
  if (!canEditLine(line)) {
    openShiftPopoverReadOnly(
      {
        line,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        day,
        shift: shift || null,
      },
      cellEl
    );
    return;
  }

  if (state.quickMode.enabled) {
    const { startLocal, endLocal, amount, templateId } = getQuickModeShift(line);

    if (!startLocal || !endLocal) {
      alert(
        "Укажите время начала и конца смены в панели быстрого назначения."
      );
      return;
    }

    const { year, monthIndex } = state.monthMeta;
    const sched = state.scheduleByLine[line];
    const resolvedDayIndex =
      typeof dayIndex === "number" && dayIndex >= 0
        ? dayIndex
        : sched?.days?.indexOf(day);
    const previousShift =
      resolvedDayIndex != null && resolvedDayIndex >= 0
        ? row.shiftsByDay[resolvedDayIndex]
        : null;

    const key = `${line}-${year}-${monthIndex + 1}-${row.employeeId}-${day}`;
    const conversion = convertLocalRangeToUtc(day, startLocal, endLocal);
    state.localChanges[key] = {
      startLocal,
      endLocal,
      amount,
      templateId,
      startUtcIso: conversion?.startUtcIso || null,
      endUtcIso: conversion?.endUtcIso || null,
      durationMinutes: conversion?.durationMinutes ?? null,
    };
    persistLocalChanges();

    applyLocalChangesToSchedule();
    renderScheduleCurrentLine();
    logChange({
      action: previousShift ? "update" : "create",
      line,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      day,
      previousShift: previousShift || null,
      nextShift: { startLocal, endLocal, amount },
    });
    return;
  }

  openShiftPopover(
    {
      line,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      day,
      shift: shift || null,
    },
    cellEl
  );
}

// -----------------------------
// Загрузка данных
// -----------------------------

async function loadInitialData() {
  try {
    await loadEmployees();
    await loadShiftsCatalog();
    initQuickAssignPanel();
    await reloadScheduleForCurrentMonth();
    updateSaveButtonState();
    updateQuickModeForLine();
  } catch (err) {
    console.error("loadInitialData error:", err);
    alert(`Ошибка загрузки данных: ${err.message || err}`);
  }
}

async function loadEmployees() {
  const raw = await pyrusApi("/v4/members", "GET");
  const data = unwrapPyrusData(raw);

  if (data.employeesByLine) {
    state.employeesByLine.L1 = data.employeesByLine.L1 || [];
    state.employeesByLine.L2 = data.employeesByLine.L2 || [];
    return;
  }

  const members = data.members || [];
  const employeesByLine = { L1: [], L2: [] };

  for (const m of members) {
    if (m.banned) continue;

    const deptName = (m.department_name || "").toLowerCase();
    const position = (m.position || "").toLowerCase();

    const isL1 =
      deptName.includes("оператор") ||
      deptName.includes("контакт-центр") ||
      position.includes("оператор");

    const isL2 =
      deptName.includes("инженер") ||
      deptName.includes("техпод") ||
      deptName.includes("техническая поддержка") ||
      position.includes("инженер");

    const employee = {
      id: m.id,
      fullName: `${m.last_name || ""} ${m.first_name || ""}`.trim(),
      email: m.email || "",
      departmentName: m.department_name || "",
      position: m.position || "",
    };

    if (isL1) employeesByLine.L1.push(employee);
    if (isL2) employeesByLine.L2.push(employee);
  }

  const sortEmployees = (arr) =>
    arr.sort((a, b) => a.fullName.localeCompare(b.fullName, "ru"));

  state.employeesByLine.L1 = sortEmployees(employeesByLine.L1);
  state.employeesByLine.L2 = sortEmployees(employeesByLine.L2);
}

async function loadShiftsCatalog() {
  const raw = await pyrusApi("/v4/catalogs/281369", "GET");
  const data = unwrapPyrusData(raw);

  const catalog = Array.isArray(data) ? data[0] : data;
  if (!catalog) return;

  const headers = catalog.catalog_headers || [];
  const items = catalog.items || [];

  const colIndexByName = {};
  headers.forEach((h, idx) => {
    colIndexByName[h.name] = idx;
  });

  const idxName = colIndexByName["Название смены"];
  const idxTime = colIndexByName["время смены"];
  const idxAmount = colIndexByName["Сумма за смену"];
  const idxDept = colIndexByName["Отдел"];

  const templatesByLine = { L1: [], L2: [] };

  for (const item of items) {
    const values = item.values || [];
    const name = idxName != null ? values[idxName] : "";
    const timeRaw = idxTime != null ? values[idxTime] : "";
    const amount = idxAmount != null ? Number(values[idxAmount] || 0) : 0;
    const dept = idxDept != null ? String(values[idxDept] || "") : "";

    const timeRange = parseShiftTimeRangeString(timeRaw);

    const normalizedName = String(name || "").trim().toUpperCase();
    const specialShortLabel = ["ВЫХ", "ОТП", "ДР"].includes(normalizedName)
      ? normalizedName
      : null;

    const template = {
      id: item.item_id,
      name,
      timeRaw,
      amount,
      dept,
      timeRange,
      specialShortLabel,
    };

    const deptUpper = dept.toUpperCase();
    if (deptUpper.includes("L1")) templatesByLine.L1.push(template);
    if (deptUpper.includes("L2")) templatesByLine.L2.push(template);
  }

  state.shiftTemplatesByLine.L1 = templatesByLine.L1;
  state.shiftTemplatesByLine.L2 = templatesByLine.L2;
}

async function reloadScheduleForCurrentMonth() {
  const { year, monthIndex } = state.monthMeta;

  const raw = await pyrusApi("/v4/forms/2375272/register", "GET");
  const data = unwrapPyrusData(raw);

  const wrapper = Array.isArray(data) ? data[0] : data;
  const tasks = (wrapper && wrapper.tasks) || [];

  const scheduleByLine = {
    L1: { days: [], rows: [], monthKey: null },
    L2: { days: [], rows: [], monthKey: null },
  };
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;

  const shiftMapByLine = {
    L1: Object.create(null),
    L2: Object.create(null),
  };

  const findField = (fields, id) => fields.find((f) => f.id === id);

  for (const task of tasks) {
    const fields = task.fields || [];
    const dueField = findField(fields, 4);
    const moneyField = findField(fields, 5);
    const personField = findField(fields, 8);
    const shiftField = findField(fields, 10);

    if (!dueField || !personField || !shiftField) continue;

    const rawDuration = Number(dueField.duration || 0);
    const startUtcMs = new Date(dueField.value).getTime();
    if (Number.isNaN(startUtcMs)) continue;

    const startUtcIso = new Date(startUtcMs).toISOString();
    const endUtcMs = startUtcMs + rawDuration * 60 * 1000;
    const endUtcIso = new Date(endUtcMs).toISOString();

    const range = convertUtcStartToLocalRange(startUtcIso, rawDuration);
    if (!range) continue;

    const { localDateKey, startLocal, endLocal } = range;
    const [yStr, mStr, dStr] = localDateKey.split("-");
    const y = Number(yStr);
    const m = Number(mStr) - 1;
    const d = Number(dStr);

    if (y !== year || m !== monthIndex) continue;

    const emp = personField.value || {};
    const empId = emp.id;
    if (!empId) continue;

    const shiftCatalog = shiftField.value || {};
    const dept = String(
      (shiftCatalog.values && shiftCatalog.values[4]) || ""
    ).toUpperCase();

    let line = null;
    if (dept.includes("L1") && !dept.includes("L2")) line = "L1";
    else if (dept.includes("L2") && !dept.includes("L1")) line = "L2";
    else if (dept.includes("L1") && dept.includes("L2")) line = "L1";
    else continue;

    const shiftItemId =
      shiftCatalog.item_id != null ? shiftCatalog.item_id : shiftCatalog.id;

    const matchingTemplate =
      shiftItemId != null && line
        ? (state.shiftTemplatesByLine[line] || []).find(
            (t) => t.id === shiftItemId
          )
        : null;
    const specialShortLabel =
      (matchingTemplate && matchingTemplate.specialShortLabel) || null;

    const amount =
      typeof moneyField.value === "number"
        ? moneyField.value
        : Number(moneyField.value || 0);

    const map = shiftMapByLine[line];
    if (!map[empId]) map[empId] = {};

    map[empId][d] = {
      startLocal,
      endLocal,
      amount,
      templateId: shiftItemId,
      taskId: task.id,
      rawDueValue: dueField.value,
      rawDuration,
      durationMinutes: rawDuration,
      startUtcIso,
      endUtcIso,
      rawShift: shiftCatalog,
      specialShortLabel,
    };
  }

  const days = [];
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  for (let d = 1; d <= Math.min(daysInMonth, MAX_DAYS_IN_MONTH); d++) {
    days.push(d);
  }

  for (const line of ["L1", "L2"]) {
    const empList = state.employeesByLine[line] || [];
    const map = shiftMapByLine[line];

    const rows = empList.map((emp) => {
      const shiftsByDay = days.map((d) => {
        const shift = map && map[emp.id] && map[emp.id][d];
        return shift || null;
      });
      return {
        employeeId: emp.id,
        employeeName: emp.fullName,
        shiftsByDay,
      };
    });

    scheduleByLine[line] = { monthKey, days, rows };
  }

  state.originalScheduleByLine = deepClone(scheduleByLine);
  state.scheduleByLine = scheduleByLine;
  applyLocalChangesToSchedule();
  renderScheduleCurrentLine();
}

// -----------------------------
// Рендер таблицы
// -----------------------------

function renderScheduleCurrentLine() {
  const line = state.ui.currentLine;
  const sched = state.scheduleByLine[line];

  if (!sched || !sched.days || sched.days.length === 0) {
    scheduleRootEl.innerHTML =
      '<div style="padding: 12px; font-size: 13px; color: var(--text-muted);">Нет данных по графику за выбранный месяц.</div>';
    return;
  }

  const canEdit = canEditLine(line);
  const { days, rows } = sched;

  const table = document.createElement("table");
  table.className = "schedule-table";
  
  if (!canEdit) {
    table.classList.add("read-only-mode");
  }

  const thead = document.createElement("thead");
  const headRow1 = document.createElement("tr");
  const headRow2 = document.createElement("tr");

  const thName = document.createElement("th");
  thName.className = "sticky-col";
  thName.textContent = "Сотрудник";
  headRow1.appendChild(thName);

  const thName2 = document.createElement("th");
  thName2.className = "sticky-col";
  thName2.textContent = "";
  headRow2.appendChild(thName2);

  const weekdayNames = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const { year, monthIndex } = state.monthMeta;
  const weekendDays = new Set();

  for (const day of days) {
    const date = new Date(year, monthIndex, day);
    const weekday = weekdayNames[(date.getDay() + 6) % 7];
    const isWeekend = weekday === "Сб" || weekday === "Вс";

    const th1 = document.createElement("th");
    th1.textContent = String(day);
    if (isWeekend) th1.classList.add("day-off");
    headRow1.appendChild(th1);

    const th2 = document.createElement("th");
    th2.textContent = weekday;
    th2.className = "weekday-header";
    if (isWeekend) {
      th2.classList.add("day-off");
      weekendDays.add(day);
    }
    headRow2.appendChild(th2);
  }

  const thSum1 = document.createElement("th");
  thSum1.textContent = "Сумма";
  thSum1.className = "summary-cell";
  headRow1.appendChild(thSum1);

  const thSum2 = document.createElement("th");
  thSum2.textContent = "";
  thSum2.className = "summary-cell";
  headRow2.appendChild(thSum2);

  thead.appendChild(headRow1);
  thead.appendChild(headRow2);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  rows.forEach((row) => {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.className = "sticky-col employee-name";
    tdName.textContent = row.employeeName;
    tr.appendChild(tdName);

    let totalAmount = 0;

    row.shiftsByDay.forEach((shift, dayIndex) => {
      const td = document.createElement("td");
      td.className = "shift-cell";
      if (weekendDays.has(sched.days[dayIndex])) {
        td.classList.add("day-off");
      }

      if (shift) {
        td.classList.add("has-shift");
        const pill = document.createElement("div");
        pill.className = "shift-pill";

        if (shift.specialShortLabel) {
          pill.classList.add("special");
          const label = document.createElement("div");
          label.className = "shift-special-label";
          label.textContent = shift.specialShortLabel;
          pill.appendChild(label);
        } else {
          const line1 = document.createElement("div");
          line1.className = "shift-time-line start";
          line1.textContent = shift.startLocal;

          const line2 = document.createElement("div");
          line2.className = "shift-time-line end";
          line2.textContent = shift.endLocal;

          pill.appendChild(line1);
          pill.appendChild(line2);
        }
        td.appendChild(pill);

        totalAmount += shift.amount || 0;
      } else {
        td.classList.add("empty-shift");
      }

      td.addEventListener("click", () => {
        handleShiftCellClick({
          line,
          row,
          day: sched.days[dayIndex],
          dayIndex,
          shift: shift || null,
          cellEl: td,
        });
      });

      td.addEventListener("mouseenter", () => {
        tr.classList.add("row-hover");
      });
      td.addEventListener("mouseleave", () => {
        tr.classList.remove("row-hover");
      });

      tr.appendChild(td);
    });

    const tdSum = document.createElement("td");
    tdSum.className = "summary-cell";
    tdSum.textContent =
      totalAmount > 0 ? `${totalAmount.toLocaleString("ru-RU")} ₽` : "";
    tr.appendChild(tdSum);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  scheduleRootEl.innerHTML = "";
  scheduleRootEl.appendChild(table);
}

// -----------------------------
// Поповер смены
// -----------------------------

function createShiftPopover() {
  shiftPopoverBackdropEl = document.createElement("div");
  shiftPopoverBackdropEl.className = "shift-popover-backdrop hidden";

  shiftPopoverEl = document.createElement("div");
  shiftPopoverEl.className = "shift-popover hidden";

  shiftPopoverBackdropEl.addEventListener("click", () => {
    closeShiftPopover();
  });

  document.body.appendChild(shiftPopoverBackdropEl);
  document.body.appendChild(shiftPopoverEl);
}

function closeShiftPopover() {
  if (!shiftPopoverEl) return;

  shiftPopoverEl.classList.remove("open");
  shiftPopoverBackdropEl.classList.add("hidden");

  if (shiftPopoverKeydownHandler) {
    document.removeEventListener("keydown", shiftPopoverKeydownHandler);
    shiftPopoverKeydownHandler = null;
  }

  setTimeout(() => {
    shiftPopoverEl.classList.add("hidden");
    shiftPopoverEl.innerHTML = "";
  }, 140);
}

function openShiftPopoverReadOnly(context, anchorEl) {
  const { line, employeeName, day, shift } = context;
  const { year, monthIndex } = state.monthMeta;
  
  const dateLabel = `${String(day).padStart(2, "0")}.${String(
    monthIndex + 1
  ).padStart(2, "0")}.${year}`;

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">${dateLabel} • Линия ${line} (только просмотр)</div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      ${shift ? `
        <div class="shift-popover-section">
          <div class="shift-popover-section-title">Информация о смене</div>
          
          <div class="field-row">
            <label>Начало:</label>
            <div>${shift.startLocal || "—"}</div>
          </div>

          <div class="field-row">
            <label>Окончание:</label>
            <div>${shift.endLocal || "—"}</div>
          </div>

          <div class="field-row">
            <label>Сумма:</label>
            <div>${shift.amount ? shift.amount.toLocaleString('ru-RU') + ' ₽' : "—"}</div>
          </div>
        </div>
      ` : `
        <div class="shift-popover-note">
          Смена не назначена. У вас нет прав на редактирование.
        </div>
      `}
    </div>

    <div class="shift-popover-footer">
      <button class="btn" type="button" id="shift-btn-close-readonly">Закрыть</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");

  const rect = anchorEl.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const estimatedWidth = 420;
  const estimatedHeight = 260;

  let left = rect.left + 8;
  let top = rect.bottom + 8;

  if (left + estimatedWidth > viewportWidth - 16) {
    left = viewportWidth - estimatedWidth - 16;
  }
  if (top + estimatedHeight > viewportHeight - 16) {
    top = rect.top - estimatedHeight - 8;
  }

  left = Math.max(left, 16);
  top = Math.max(top, 16);

  shiftPopoverEl.style.left = `${left}px`;
  shiftPopoverEl.style.top = `${top}px`;

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });

  shiftPopoverEl
    .querySelector(".shift-popover-close")
    .addEventListener("click", closeShiftPopover);
  shiftPopoverEl
    .querySelector("#shift-btn-close-readonly")
    .addEventListener("click", closeShiftPopover);

  shiftPopoverKeydownHandler = (e) => {
    if (e.key === "Escape") closeShiftPopover();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);
}

function openShiftPopover(context, anchorEl) {
  const { line, employeeId, employeeName, day, shift } = context;
  const { year, monthIndex } = state.monthMeta;
  const date = new Date(year, monthIndex, day);
  const hasShift = Boolean(shift);
  let selectedTemplateId = shift?.templateId ?? null;

  const dateLabel = `${String(day).padStart(2, "0")}.${String(
    monthIndex + 1
  ).padStart(2, "0")}.${year}`;

  const templates = state.shiftTemplatesByLine[line] || [];

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">${dateLabel} • Линия ${line}</div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Шаблоны смен</div>
        <div class="shift-template-list">
          ${templates
            .map(
              (t) => `
            <button class="shift-template-pill" data-template-id="${t.id}">
              <div class="name">${t.name}</div>
              ${
                t.timeRange
                  ? `<div class="time">${t.timeRange.start}–${t.timeRange.end}</div>`
                  : ""
              }
            </button>
          `
            )
            .join("")}
        </div>
      </div>

      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Ручное редактирование</div>

        <div class="field-row">
          <label>Начало</label>
          <input type="time" id="shift-start-input" value="${
            shift?.startLocal || ""
          }">
        </div>

        <div class="field-row">
          <label>Окончание</label>
          <input type="time" id="shift-end-input" value="${
            shift?.endLocal || ""
          }">
        </div>

        <div class="field-row">
          <label>Сумма</label>
          <input type="number" id="shift-amount-input" value="${
            shift?.amount || ""
          }">
        </div>

        <div class="shift-popover-note">
          Изменения сохраняются в локальном кэше в браузере и не отправляются в Pyrus.
        </div>
      </div>
    </div>

    <div class="shift-popover-footer">
      <button class="btn danger" type="button" id="shift-btn-delete" ${
        hasShift ? "" : "disabled"
      }>Удалить</button>
      <button class="btn" type="button" id="shift-btn-cancel">Отмена</button>
      <button class="btn primary" type="button" id="shift-btn-save">Сохранить локально</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");

  const rect = anchorEl.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const estimatedWidth = 420;
  const estimatedHeight = 260;

  let left = rect.left + 8;
  let top = rect.bottom + 8;

  if (left + estimatedWidth > viewportWidth - 16) {
    left = viewportWidth - estimatedWidth - 16;
  }
  if (top + estimatedHeight > viewportHeight - 16) {
    top = rect.top - estimatedHeight - 8;
  }

  left = Math.max(left, 16);
  top = Math.max(top, 16);

  shiftPopoverEl.style.left = `${left}px`;
  shiftPopoverEl.style.top = `${top}px`;

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });

  shiftPopoverEl
    .querySelector(".shift-popover-close")
    .addEventListener("click", closeShiftPopover);
  shiftPopoverEl
    .querySelector("#shift-btn-cancel")
    .addEventListener("click", closeShiftPopover);

  const deleteBtn = shiftPopoverEl.querySelector("#shift-btn-delete");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      const key = `${line}-${year}-${monthIndex + 1}-${employeeId}-${day}`;
      state.localChanges[key] = { deleted: true };
      persistLocalChanges();

      applyLocalChangesToSchedule();
      renderScheduleCurrentLine();
      logChange({
        action: "delete",
        line,
        employeeId,
        employeeName,
        day,
        previousShift: shift || null,
        nextShift: null,
      });
      closeShiftPopover();
    });
  }

  shiftPopoverEl
    .querySelectorAll(".shift-template-pill")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-template-id"));
        const tmpl = templates.find((t) => t.id === id);
        if (!tmpl) return;

        selectedTemplateId = id;

        if (tmpl.timeRange) {
          const startInput = document.getElementById("shift-start-input");
          const endInput = document.getElementById("shift-end-input");
          if (startInput && endInput) {
            startInput.value = tmpl.timeRange.start;
            endInput.value = tmpl.timeRange.end;
          }
        }

        const amountInput = document.getElementById("shift-amount-input");
        if (amountInput && tmpl.amount) {
          amountInput.value = tmpl.amount;
        }
      });
    });

  shiftPopoverEl
    .querySelector("#shift-btn-save")
    .addEventListener("click", () => {
      const startInput = document.getElementById("shift-start-input");
      const endInput = document.getElementById("shift-end-input");
      const amountInput = document.getElementById("shift-amount-input");

      const start = startInput.value;
      const end = endInput.value;
      const amount = Number(amountInput.value || 0);

      const key = `${line}-${year}-${monthIndex + 1}-${employeeId}-${day}`;
      const templateId =
        selectedTemplateId != null ? selectedTemplateId : shift?.templateId;
      const conversion = convertLocalRangeToUtc(day, start, end);
      state.localChanges[key] = {
        startLocal: start,
        endLocal: end,
        amount,
        templateId,
        startUtcIso: conversion?.startUtcIso || null,
        endUtcIso: conversion?.endUtcIso || null,
        durationMinutes: conversion?.durationMinutes ?? null,
      };
      persistLocalChanges();

      applyLocalChangesToSchedule();
      renderScheduleCurrentLine();
      logChange({
        action: shift ? "update" : "create",
        line,
        employeeId,
        employeeName,
        day,
        previousShift: shift || null,
        nextShift: { startLocal: start, endLocal: end, amount },
      });
      closeShiftPopover();
    });

  shiftPopoverKeydownHandler = (e) => {
    if (e.key === "Escape") closeShiftPopover();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);
}

function applyLocalChangesToSchedule() {
  for (const line of ["L1", "L2"]) {
    const sched = state.scheduleByLine[line];
    if (!sched || !sched.rows) continue;

    const { year, monthIndex } = state.monthMeta;

    for (const row of sched.rows) {
      sched.days.forEach((day, idx) => {
        const key = `${line}-${year}-${
          monthIndex + 1
        }-${row.employeeId}-${day}`;
        const change = state.localChanges[key];
        if (!change || typeof change !== "object") return;

        if (change.deleted) {
          row.shiftsByDay[idx] = null;
          return;
        }

        const enriched = change.startUtcIso
          ? change
          : convertLocalRangeToUtc(day, change.startLocal, change.endLocal) ||
            change;

        if (!row.shiftsByDay[idx]) {
          row.shiftsByDay[idx] = {
            startLocal: change.startLocal,
            endLocal: change.endLocal,
            amount: Number(change.amount || 0),
            templateId: change.templateId ?? null,
            startUtcIso: enriched.startUtcIso || null,
            endUtcIso: enriched.endUtcIso || null,
            durationMinutes: enriched.durationMinutes ?? null,
          };
        } else {
          row.shiftsByDay[idx].startLocal = change.startLocal;
          row.shiftsByDay[idx].endLocal = change.endLocal;
          row.shiftsByDay[idx].amount = Number(change.amount || 0);
          if (change.templateId != null) {
            row.shiftsByDay[idx].templateId = change.templateId;
          }
          row.shiftsByDay[idx].startUtcIso = enriched.startUtcIso || null;
          row.shiftsByDay[idx].endUtcIso = enriched.endUtcIso || null;
          row.shiftsByDay[idx].durationMinutes =
            enriched.durationMinutes ?? row.shiftsByDay[idx].durationMinutes;
        }
      });
    }
  }
}

document.addEventListener("DOMContentLoaded", init);