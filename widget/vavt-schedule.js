// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: calendar-alt;

// Расписание ВАВТ — виджет для Scriptable.
// Данные готовит GitHub Actions (папка parser/ в репозитории) и кладёт в data/schedule.json.
// Параметр виджета (долгое нажатие → Изменить виджет → Parameter) можно не задавать.
//   "next"  — следующая пара крупно (по умолчанию для маленького виджета)
//   "today" — список пар на сегодня (по умолчанию для среднего и большого)

const DATA_URL = "https://raw.githubusercontent.com/tipo4ekgg/vavt-schedule/main/data/schedule.json";

const KIND = { "л": "лекция", "с": "семинар", "ПЗ": "практика", "лаб": "лаб." };
const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const WD_FULL = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

// ------------------------------------------------------------ логика (без API Scriptable)

function toDate(isoDay, hhmm) {
  const [y, m, d] = isoDay.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
}

function isoOf(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// Все пары плоским списком с настоящими датами, по времени.
function flatten(data) {
  const out = [];
  for (const week of data.weeks || []) {
    for (const day of week.days || []) {
      for (const l of day.lessons || []) {
        out.push({ ...l, date: day.date, note: day.note, from: toDate(day.date, l.start), to: toDate(day.date, l.end) });
      }
    }
  }
  out.sort((a, b) => a.from - b.from || a.title.localeCompare(b.title));
  return out;
}

// Текущая пара (если идёт) и следующие за ней.
function upcoming(lessons, now) {
  return lessons.filter((l) => l.to > now);
}

// День, который стоит показывать: сегодня, если пары ещё будут, иначе ближайший учебный день.
function dayToShow(lessons, now) {
  const left = upcoming(lessons, now);
  if (!left.length) return null;
  const day = left[0].date;
  return {
    date: day,
    isToday: day === isoOf(now),
    lessons: lessons.filter((l) => l.date === day),
  };
}

function relTime(from, now) {
  const min = Math.round((from - now) / 60000);
  if (min <= 0) return "сейчас";
  if (min < 60) return `через ${min} мин`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `через ${h} ч ${m} мин` : `через ${h} ч`;
  return null;
}

function dayTitle(isoDay, now) {
  const d = toDate(isoDay, "00:00");
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((d - today) / 86400000);
  const date = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  if (diff === 0) return `Сегодня, ${date}`;
  if (diff === 1) return `Завтра, ${date}`;
  return `${WD_FULL[d.getDay()][0].toUpperCase()}${WD_FULL[d.getDay()].slice(1)}, ${date}`;
}

// Когда виджету имеет смысл обновиться: конец текущей пары или начало следующей.
function nextRefresh(lessons, now) {
  const marks = [];
  for (const l of lessons) {
    if (l.from > now) marks.push(l.from);
    if (l.to > now) marks.push(l.to);
  }
  marks.sort((a, b) => a - b);
  const soon = new Date(now.getTime() + 15 * 60000);
  const later = new Date(now.getTime() + 3 * 3600000);
  const t = marks[0] && marks[0] < later ? marks[0] : later;
  return t < soon ? soon : t;
}

function meta(l) {
  return [KIND[l.kind] || l.kind, l.room ? `ауд. ${l.room}` : null].filter(Boolean).join(" · ");
}

function asText(lessons, now) {
  const left = upcoming(lessons, now);
  const days = [...new Set(left.map((l) => l.date))];
  return days.map((d) => {
    const items = lessons.filter((l) => l.date === d)
      .map((l) => `${l.start}–${l.end}  ${l.raw}`);
    return `${dayTitle(d, now)}\n${items.join("\n")}`;
  }).join("\n\n");
}

// ------------------------------------------------------------ Scriptable

if (typeof ListWidget === "undefined") {
  module.exports = { flatten, upcoming, dayToShow, relTime, dayTitle, nextRefresh, meta, asText, toDate, isoOf };
} else {
  await run();
}

async function loadData() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.cacheDirectory(), "vavt-schedule.json");
  try {
    const req = new Request(DATA_URL + "?t=" + Date.now());
    req.timeoutInterval = 15;
    const data = await req.loadJSON();
    if (!data || !data.weeks) throw new Error("пустой ответ");
    fm.writeString(cache, JSON.stringify(data));
    return { data, stale: false };
  } catch (e) {
    if (fm.fileExists(cache)) return { data: JSON.parse(fm.readString(cache)), stale: true };
    throw e;
  }
}

function colors() {
  return {
    bg: Color.dynamic(new Color("#F4F1EA"), new Color("#16181D")),
    text: Color.dynamic(new Color("#1B1B1F"), new Color("#F2F2F4")),
    dim: Color.dynamic(new Color("#6B6B73"), new Color("#9A9AA5")),
    accent: Color.dynamic(new Color("#B23A2E"), new Color("#F07A6A")),
    now: Color.dynamic(new Color("#1F6F5C"), new Color("#5BD1B0")),
  };
}

async function run() {
  const now = new Date();
  const family = config.widgetFamily || "medium";
  const param = (args.widgetParameter || "").trim().toLowerCase();
  const mode = param || (family === "small" ? "next" : "today");
  const c = colors();

  let data, stale = false, error = null;
  try {
    ({ data, stale } = await loadData());
  } catch (e) {
    error = String(e);
  }

  const w = new ListWidget();
  w.backgroundColor = c.bg;
  w.setPadding(14, 14, 12, 14);

  if (error) {
    const t = w.addText("Нет данных расписания");
    t.font = Font.semiboldSystemFont(13); t.textColor = c.text;
    const e = w.addText(error);
    e.font = Font.systemFont(10); e.textColor = c.dim;
    w.refreshAfterDate = new Date(now.getTime() + 30 * 60000);
    return finish(w, null);
  }

  const lessons = flatten(data);
  w.refreshAfterDate = nextRefresh(lessons, now);
  w.url = data.source || "https://www.vavt.ru/schedule/";

  if (mode === "next") renderNext(w, lessons, now, c, data);
  else renderDay(w, lessons, now, c, data, family);

  if (stale) {
    w.addSpacer(2);
    const s = w.addText("нет сети — показан кеш");
    s.font = Font.systemFont(9); s.textColor = c.dim;
  }
  return finish(w, asText(lessons, now));
}

function header(w, left, right, c) {
  const h = w.addStack();
  h.centerAlignContent();
  const a = h.addText(left);
  a.font = Font.boldSystemFont(12); a.textColor = c.accent; a.lineLimit = 1;
  h.addSpacer();
  if (right) {
    const b = h.addText(right);
    b.font = Font.mediumSystemFont(11); b.textColor = c.dim;
  }
}

function renderNext(w, lessons, now, c, data) {
  const left = upcoming(lessons, now);
  header(w, data.group.replace(/^Б\d+М-/, ""), null, c);
  w.addSpacer(6);
  if (!left.length) {
    const t = w.addText("Пар больше нет");
    t.font = Font.semiboldSystemFont(15); t.textColor = c.text;
    w.addSpacer();
    return;
  }
  const l = left[0];
  const going = l.from <= now;
  const when = going ? `идёт · до ${l.end}` : (relTime(l.from, now) || dayTitle(l.date, now));
  const top = w.addText(when);
  top.font = Font.semiboldSystemFont(11); top.textColor = going ? c.now : c.dim;
  w.addSpacer(2);
  const time = w.addText(`${l.start}–${l.end}`);
  time.font = Font.boldMonospacedSystemFont(17); time.textColor = c.text;
  w.addSpacer(4);
  const t = w.addText(l.title);
  t.font = Font.semiboldSystemFont(14); t.textColor = c.text; t.lineLimit = 3; t.minimumScaleFactor = 0.7;
  w.addSpacer();
  const m = w.addText(meta(l) || " ");
  m.font = Font.mediumSystemFont(11); m.textColor = c.dim; m.lineLimit = 1;
  const after = left[1];
  if (after && after.date === l.date) {
    const n = w.addText(`дальше ${after.start} ${after.title}`);
    n.font = Font.systemFont(10); n.textColor = c.dim; n.lineLimit = 1;
  }
}

function renderDay(w, lessons, now, c, data, family) {
  const day = dayToShow(lessons, now);
  if (!day) {
    header(w, data.group, null, c);
    w.addSpacer();
    const t = w.addText("Пар на ближайшие дни нет");
    t.font = Font.semiboldSystemFont(14); t.textColor = c.text;
    w.addSpacer();
    return;
  }
  header(w, dayTitle(day.date, now), data.group.replace(/^Б\d+М-/, ""), c);
  w.addSpacer(6);

  const max = family === "large" ? 8 : 4;
  // На среднем виджете сегодня прошедшие пары прячем, чтобы влезли оставшиеся.
  let list = day.lessons;
  if (day.isToday && list.length > max) list = list.filter((l) => l.to > now);
  const shown = list.slice(0, max);

  for (const l of shown) {
    const done = l.to <= now;
    const going = l.from <= now && !done;
    const row = w.addStack();
    row.topAlignContent();
    const time = row.addText(l.start);
    time.font = Font.boldMonospacedSystemFont(12);
    time.textColor = going ? c.now : done ? c.dim : c.text;
    row.addSpacer(8);
    const col = row.addStack();
    col.layoutVertically();
    const t = col.addText(l.title);
    t.font = going ? Font.boldSystemFont(12) : Font.mediumSystemFont(12);
    t.textColor = done ? c.dim : c.text;
    t.lineLimit = 1;
    if (family === "large") {
      const m = col.addText([meta(l), l.teacher].filter(Boolean).join(" · ") || " ");
      m.font = Font.systemFont(10); m.textColor = c.dim; m.lineLimit = 1;
    } else if (l.room) {
      row.addSpacer();
      const r = row.addText(l.room);
      r.font = Font.mediumMonospacedSystemFont(11); r.textColor = c.dim;
    }
    w.addSpacer(family === "large" ? 6 : 4);
  }
  if (list.length > shown.length) {
    const more = w.addText(`ещё ${list.length - shown.length}…`);
    more.font = Font.systemFont(10); more.textColor = c.dim;
  }
  if (day.lessons[0] && day.lessons[0].note) {
    const n = w.addText(day.lessons[0].note);
    n.font = Font.systemFont(10); n.textColor = c.dim;
  }
  w.addSpacer();
}

async function finish(w, text) {
  if (config.runsInWidget) {
    Script.setWidget(w);
  } else if (text !== null && config.runsInApp && !args.widgetParameter) {
    // Запуск из приложения: превью виджета + вся неделя текстом.
    await w.presentMedium();
    const a = new Alert();
    a.title = "Расписание";
    a.message = text || "Пар нет";
    a.addAction("OK");
    await a.present();
  } else {
    await w.presentMedium();
  }
  Script.complete();
}
