import { pyrusFetch } from "./pyrusAuth.js";

/**
 * Загружаем список сотрудников из Pyrus (/members) и раскладываем по линиям L1 / L2.
 *
 * Правила:
 * - L1: отдел «Операторы»
 *   - department_name === "Операторы"
 *   - И/ИЛИ department_id из набора L1
 *
 * - L2: инженерные линии
 *   - department_name ∈ ["Инженера 5/2", "Инженера 2/2", "Инженеры"]
 *   - И/ИЛИ department_id из набора L2
 *
 * Если ни одно условие не срабатывает — сотрудник попадает в byLine.extra.
 *
 * Возвращаем объект:
 * {
 *   all:  [ { id, name, department_id, department_name, raw } ],
 *   byId: { [id]: employee },
 *   byLine: { L1: [...], L2: [...], extra: [...] }
 * }
 */

// Конфиг линий: поддержка и по department_id, и по department_name.
const LINE_RULES = {
  L1: {
    departmentIds: new Set([
      // Операторы
      108368027,
    ]),
    departmentNames: new Set(["Операторы"]),
  },
  L2: {
    departmentIds: new Set([
      // Инженера 5/2
      171248779,
      // Инженера 2/2
      171248780,
      // Инженеры
      108368026,
    ]),
    departmentNames: new Set(["Инженера 5/2", "Инженера 2/2", "Инженеры"]),
  },
};

// Порядок сортировки для L2 по department_id / department_name.
const L2_ORDER_BY_DEPARTMENT_ID = {
  171248779: 0, // Инженера 5/2
  171248780: 1, // Инженера 2/2
  108368026: 2, // Инженеры
};

const L2_ORDER_BY_DEPARTMENT_NAME = {
  "Инженера 5/2": 0,
  "Инженера 2/2": 1,
  Инженеры: 2,
};

/**
 * Определяем линию по department_id / department_name.
 * @param {number | null} departmentId
 * @param {string | null} departmentName
 * @returns {"L1" | "L2" | "extra"}
 */
function resolveLine(departmentId, departmentName) {
  const name = departmentName || null;
  const id = typeof departmentId === "number" ? departmentId : null;

  // Сначала проверяем L1
  if (
    (id !== null && LINE_RULES.L1.departmentIds.has(id)) ||
    (name && LINE_RULES.L1.departmentNames.has(name))
  ) {
    return "L1";
  }

  // Потом L2
  if (
    (id !== null && LINE_RULES.L2.departmentIds.has(id)) ||
    (name && LINE_RULES.L2.departmentNames.has(name))
  ) {
    return "L2";
  }

  return "extra";
}

export async function loadEmployeesFromPyrus() {
  const res = await pyrusFetch({
    type: "pyrus_api",
    path: "/members",
  });

  const members = Array.isArray(res?.members) ? res.members : [];

  const employees = [];
  const byId = {};
  const byLine = {
    L1: [],
    L2: [],
    extra: [],
  };

  for (const m of members) {
    const departmentId =
      typeof m.department_id === "number" ? m.department_id : null;
    const departmentName =
      typeof m.department_name === "string"
        ? m.department_name.trim()
        : null;

    const employee = {
      id: m.id,
      name: [m.first_name, m.last_name].filter(Boolean).join(" ").trim(),
      department_id: departmentId,
      department_name: departmentName,
      raw: m,
    };

    employees.push(employee);
    if (employee.id != null) {
      byId[employee.id] = employee;
    }

    const line = resolveLine(departmentId, departmentName);
    if (line === "L1") {
      byLine.L1.push(employee);
    } else if (line === "L2") {
      byLine.L2.push(employee);
    } else {
      byLine.extra.push(employee);
    }
  }

  // сортировка L2: по линии (5/2 → 2/2 → Инженеры), затем по имени
  byLine.L2.sort((a, b) => {
    const da = a.department_id ?? null;
    const db = b.department_id ?? null;

    const orderAId =
      da !== null && L2_ORDER_BY_DEPARTMENT_ID.hasOwnProperty(da)
        ? L2_ORDER_BY_DEPARTMENT_ID[da]
        : null;
    const orderBId =
      db !== null && L2_ORDER_BY_DEPARTMENT_ID.hasOwnProperty(db)
        ? L2_ORDER_BY_DEPARTMENT_ID[db]
        : null;

    let oa = orderAId;
    let ob = orderBId;

    // fallback по имени отдела, если id не сопоставлен
    if (oa === null) {
      const nameA = a.department_name || "";
      oa =
        L2_ORDER_BY_DEPARTMENT_NAME.hasOwnProperty(nameA) ?
        L2_ORDER_BY_DEPARTMENT_NAME[nameA] :
        99;
    }

    if (ob === null) {
      const nameB = b.department_name || "";
      ob =
        L2_ORDER_BY_DEPARTMENT_NAME.hasOwnProperty(nameB) ?
        L2_ORDER_BY_DEPARTMENT_NAME[nameB] :
        99;
    }

    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name, "ru");
  });

  // сортировка L1 и extra просто по имени
  byLine.L1.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  byLine.extra.sort((a, b) => a.name.localeCompare(b.name, "ru"));

  console.log("Сотрудники из Pyrus", { employees, byLine });

  return {
    all: employees,
    byId,
    byLine,
  };
}
