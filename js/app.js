// app.js
// Главный модуль SPA для графика смен L1/L2
// Чистый vanilla JS.

/**
 * Основные сущности:
 * - Авторизация через n8n /graph (type: "auth")
 * - Pyrus API через n8n /graph (type: "pyrus_api")
 * - Кеширование данных смен в памяти
 * - UI: таблица, ховер строки, анимация ячеек, компактный поповер смены
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
  localChanges: {},
  monthMeta: {
    year: null,
    monthIndex: null,
  },
};

const scheduleCacheByLine = {
  L1: Object.create(null),
  L2: Object.create(null),
};

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

/**
 * Pyrus: due (UTC) + duration -> локальное начало/конец (GMT+4)
 */
function convertUtcDueToLocalRange(utcIsoString, durationMinutes) {
  if (!utcIsoString || typeof utcIsoString !== "string") return null;
  const utcDate = new Date(utcIsoString);
  if (Number.isNaN(utcDate.getTime())) return null;

  const dueLocalMs =
    utcDate.getTime() + LOCAL_TZ_OFFSET_MIN * 60 * 1000;
  const dueLocal = new Date(dueLocalMs);

  const endMinutes = dueLocal.getHours() * 60 + dueLocal.getMinutes();
  const { time: startLocal, dayShift } = addMinutesLocal(
    endMinutes,
    -(durationMinutes || 0)
  );

  const endHH = String(dueLocal.getHours()).padStart(2, "0");
  const endMM = String(dueLocal.getMinutes()).padStart(2, "0");
  const endLocal = `${endHH}:${endMM}`;

  const startDate = new Date(
    dueLocal.getFullYear(),
    dueLocal.getMonth(),
    dueLocal.getDate()
  );
  startDate.setDate(startDate.getDate() + dayShift);

  const y = startDate.getFullYear();
  const m = String(startDate.getMonth() + 1).padStart(2, "0");
  const d = String(startDate.getDate()).padStart(2, "0");

  return {
    localDateKey: `${y}-${m}-${d}`,
    startLocal,
    endLocal,
  };
}

function formatShiftTimeForCell(startLocal, endLocal) {
  return { start: startLocal, end: endLocal };
}

// -----------------------------
// API-слой
// -----------------------------

async function callGraphApi(type, payload) {
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

const currentUserLabelEl = $("#current-user-label");
const currentMonthLabelEl = $("#current-month-label");

const btnLineL1El = $("#btn-line-l1");
const btnLineL2El = $("#btn-line-l2");
const btnPrevMonthEl = $("#btn-prev-month");
const btnNextMonthEl = $("#btn-next-month");

const scheduleRootEl = $("#schedule-root");

// поповер смены
let shiftPopoverEl = null;
let shiftPopoverBackdropEl = null;
let shiftPopoverKeydownHandler = null;

// -----------------------------
// Инициализация
// -----------------------------

function init() {
  initMonthMetaToToday();
  bindLoginForm();
  bindTopBarButtons();
  createShiftPopover();
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

// -----------------------------
// События
// -----------------------------

function bindLoginForm() {
  loginFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginErrorEl.textContent = "";
    const btn = loginFormEl.querySelector("button[type=submit]");
    btn.disabled = true;

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
      btn.disabled = false;
    }
  });
}

function bindTopBarButtons() {
  btnLineL1El.addEventListener("click", () => {
    state.ui.currentLine = "L1";
    updateLineToggleUI();
    renderScheduleCurrentLine();
  });

  btnLineL2El.addEventListener("click", () => {
    state.ui.currentLine = "L2";
    updateLineToggleUI();
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

// -----------------------------
// Загрузка данных
// -----------------------------

async function loadInitialData() {
  try {
    await loadEmployees();
    await loadShiftsCatalog();
    await reloadScheduleForCurrentMonth();
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

    const template = {
      id: item.item_id,
      name,
      timeRaw,
      amount,
      dept,
      timeRange,
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

    const range = convertUtcDueToLocalRange(
      dueField.value,
      Number(dueField.duration || 0)
    );
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

    const amount =
      typeof moneyField.value === "number"
        ? moneyField.value
        : Number(moneyField.value || 0);

    const shiftTimes = formatShiftTimeForCell(startLocal, endLocal);

    const map = shiftMapByLine[line];
    if (!map[empId]) map[empId] = {};

    map[empId][d] = {
      startLocal: shiftTimes.start,
      endLocal: shiftTimes.end,
      amount,
      taskId: task.id,
      rawDueValue: dueField.value,
      rawDuration: Number(dueField.duration || 0),
      rawShift: shiftCatalog,
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

  const { days, rows } = sched;

  const table = document.createElement("table");
  table.className = "schedule-table";

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

  for (const day of days) {
    const date = new Date(year, monthIndex, day);
    const weekday = weekdayNames[(date.getDay() + 6) % 7];

    const th1 = document.createElement("th");
    th1.textContent = String(day);
    headRow1.appendChild(th1);

    const th2 = document.createElement("th");
    th2.textContent = weekday;
    th2.className = "weekday-header";
    if (weekday === "Сб" || weekday === "Вс") th2.classList.add("day-off");
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

      if (shift) {
        td.classList.add("has-shift");
        const pill = document.createElement("div");
        pill.className = "shift-pill";

        const line1 = document.createElement("div");
        line1.className = "shift-time-line start";
        line1.textContent = shift.startLocal;

        const line2 = document.createElement("div");
        line2.className = "shift-time-line end";
        line2.textContent = shift.endLocal;

        pill.appendChild(line1);
        pill.appendChild(line2);
        td.appendChild(pill);

        totalAmount += shift.amount || 0;
      } else {
        td.classList.add("empty-shift");
      }

      td.addEventListener("click", () => {
        openShiftPopover(
          {
            line,
            employeeId: row.employeeId,
            employeeName: row.employeeName,
            day: sched.days[dayIndex],
            shift: shift || null,
          },
          td
        );
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

function openShiftPopover(context, anchorEl) {
  const { line, employeeId, employeeName, day, shift } = context;
  const { year, monthIndex } = state.monthMeta;
  const date = new Date(year, monthIndex, day);

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
      <button class="btn" type="button" id="shift-btn-cancel">Отмена</button>
      <button class="btn primary" type="button" id="shift-btn-save">Сохранить локально</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");

  // позиционируем поповер рядом с ячейкой
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

  // маленькая «пружинка» при открытии
  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });

  // закрытие
  shiftPopoverEl
    .querySelector(".shift-popover-close")
    .addEventListener("click", closeShiftPopover);
  shiftPopoverEl
    .querySelector("#shift-btn-cancel")
    .addEventListener("click", closeShiftPopover);

  // выбор шаблона
  shiftPopoverEl
    .querySelectorAll(".shift-template-pill")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-template-id"));
        const tmpl = templates.find((t) => t.id === id);
        if (!tmpl) return;

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

  // сохранение в локальный кэш
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
      state.localChanges[key] = { startLocal: start, endLocal: end, amount };

      applyLocalChangesToSchedule();
      renderScheduleCurrentLine();
      closeShiftPopover();
    });

  // esc для закрытия
  shiftPopoverKeydownHandler = (e) => {
    if (e.key === "Escape") closeShiftPopover();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);
}

// применяем локальные изменения к расписанию
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
        if (!change) return;

        if (!row.shiftsByDay[idx]) {
          row.shiftsByDay[idx] = {
            startLocal: change.startLocal,
            endLocal: change.endLocal,
            amount: change.amount,
          };
        } else {
          row.shiftsByDay[idx].startLocal = change.startLocal;
          row.shiftsByDay[idx].endLocal = change.endLocal;
          row.shiftsByDay[idx].amount = change.amount;
        }
      });
    }
  }
}

// -----------------------------
// Старт
// -----------------------------

document.addEventListener("DOMContentLoaded", init);
