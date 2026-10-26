// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: stopwatch;

// Расписание ВАВТ — виджет для экрана блокировки (Scriptable).
// Показывает живой отсчёт: до конца идущей пары или до начала следующей.
// Размеры: прямоугольный (таймер + пара + аудитория), круглый (таймер),
// строка над часами (пара и время окончания/начала).

const DATA_URLS = [
  "https://raw.githubusercontent.com/Tipo4ekGG/vavt-schedule/main/data/schedule.json",
  "https://cdn.jsdelivr.net/gh/Tipo4ekGG/vavt-schedule@main/data/schedule.json",
];

// Пары, которые не показывать (по началу названия).
const HIDE = ["Русский как иностранный"];

// Короткие названия (по началу названия).
const SHORT = [
  ["Иностранный язык (второй)", "Ин. яз (2-й)"],
  ["Иностранный язык", "Ин. яз"],
  ["Русский как иностранный", "РКИ"],
  ["Физическая культура", "Физра"],
  ["Элективные курсы по физической", "Физра"],
  ["Математический анализ", "Матан"],
  ["Линейная алгебра", "Линал"],
  ["Микроэкономика", "Микроэк."],
  ["Макроэкономика", "Макроэк."],
  ["Экономико-географические", "География"],
  ["Социально-психологическое", "Псих. тест"],
  ["Социология", "Социол."],
  ["История России", "История"],
  ["Правоведение", "Право"],
  ["Теория вероятностей", "Теорвер"],
];

// ------------------------------------------------------------ логика

function toDate(isoDay, hhmm) {
  const [y, m, d] = isoDay.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
}

function isoOf(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function shortTitle(title) {
  for (const [from, to] of SHORT) if (title.startsWith(from)) return to;
  return title;
}

function label(l) {
  const t = shortTitle(l.title);
  return l.kind ? `${t} (${l.kind})` : t;
}

function flatten(data) {
  const out = [];
  for (const week of data.weeks || []) {
    for (const day of week.days || []) {
      for (const l of day.lessons || []) {
        if (HIDE.some((h) => (l.title || l.raw || "").startsWith(h))) continue;
        out.push({ ...l, date: day.date, from: toDate(day.date, l.start), to: toDate(day.date, l.end) });
      }
    }
  }
  out.sort((a, b) => a.from - b.from);
  return out;
}

// Что показывать сейчас.
//  going — идёт пара, отсчёт до конца
//  break — сегодня ещё будет пара, отсчёт до начала
//  later — сегодня пар больше нет, показываем ближайшую (без таймера)
function status(lessons, now) {
  const today = isoOf(now);
  const cur = lessons.find((l) => l.from <= now && l.to > now);
  if (cur) return { kind: "going", target: cur.to, lesson: cur };
  const next = lessons.find((l) => l.from > now);
  if (!next) return { kind: "none" };
  if (next.date === today) return { kind: "break", target: next.from, lesson: next };
  return { kind: "later", lesson: next };
}

function dayWord(isoDay, now) {
  const d = toDate(isoDay, "00:00");
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((d - t) / 86400000);
  if (diff === 1) return "Завтра";
  return ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][d.getDay()];
}

function nextRefresh(st, now) {
  const in15 = new Date(now.getTime() + 15 * 60000);
  const min = new Date(now.getTime() + 60000);
  if (st.target && st.target < in15) return st.target > min ? st.target : min;
  return in15;
}

// ------------------------------------------------------------ Scriptable

if (typeof ListWidget === "undefined") {
  module.exports = { flatten, status, label, dayWord, nextRefresh, isoOf };
} else {
  await run();
}

async function loadData() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.cacheDirectory(), "vavt-schedule.json");
  for (const url of DATA_URLS) {
    try {
      const req = new Request(url + "?t=" + Date.now());
      req.timeoutInterval = 12;
      const data = await req.loadJSON();
      if (data && data.weeks) {
        fm.writeString(cache, JSON.stringify(data));
        return data;
      }
    } catch (e) {}
  }
  if (fm.fileExists(cache)) return JSON.parse(fm.readString(cache));
  return null;
}

async function run() {
  const now = new Date();
  const family = config.widgetFamily || "accessoryRectangular";
  const data = await loadData();
  const st = data ? status(flatten(data), now) : { kind: "error" };

  const w = new ListWidget();
  w.refreshAfterDate = nextRefresh(st, now);

  if (family === "accessoryInline") inline(w, st, now);
  else if (family === "accessoryCircular") circular(w, st, now);
  else rectangular(w, st, now);

  if (config.runsInAccessoryWidget || config.runsInWidget) Script.setWidget(w);
  else await w.presentAccessoryRectangular();
  Script.complete();
}

function rectangular(w, st, now) {
  w.setPadding(0, 0, 0, 0);
  if (st.kind === "error") {
    w.addText("Нет данных расписания").font = Font.semiboldSystemFont(13);
    return;
  }
  if (st.kind === "none") {
    w.addText("Пар больше нет").font = Font.semiboldSystemFont(14);
    return;
  }
  const l = st.lesson;
  const top = w.addText(
    st.kind === "going" ? "До конца пары" :
    st.kind === "break" ? "До начала пары" :
    `${dayWord(l.date, now)} в ${l.start}`
  );
  top.font = Font.semiboldSystemFont(11);
  top.textOpacity = 0.75;

  if (st.target) {
    const t = w.addDate(st.target);
    t.applyTimerStyle();
    t.font = Font.boldMonospacedSystemFont(24);
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.8;
  }

  const row = w.addStack();
  row.centerAlignContent();
  const n = row.addText(label(l));
  n.font = Font.mediumSystemFont(st.target ? 12 : 16);
  n.lineLimit = 1;
  if (l.room) {
    row.addSpacer(4);
    const r = row.addText(l.room);
    r.font = Font.systemFont(11);
    r.textOpacity = 0.75;
  }
  row.addSpacer();
}

function circular(w, st, now) {
  w.addAccessoryWidgetBackground = true;
  w.setPadding(2, 2, 2, 2);
  const s = w.addStack();
  s.layoutVertically();
  s.centerAlignContent();

  const add = (text, font, op) => {
    const r = s.addStack();
    r.addSpacer();
    const t = r.addText(text);
    t.font = font;
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.6;
    if (op) t.textOpacity = op;
    r.addSpacer();
  };

  if (st.kind === "error" || st.kind === "none") {
    add("—", Font.boldSystemFont(18));
    return;
  }
  if (!st.target) {
    add(dayWord(st.lesson.date, now), Font.semiboldSystemFont(10), 0.75);
    add(st.lesson.start, Font.boldSystemFont(15));
    return;
  }
  add(st.kind === "going" ? "конец" : "начало", Font.semiboldSystemFont(9), 0.75);
  const r = s.addStack();
  r.addSpacer();
  const t = r.addDate(st.target);
  t.applyTimerStyle();
  t.font = Font.boldMonospacedSystemFont(14);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  t.centerAlignText();
  r.addSpacer();
}

function inline(w, st, now) {
  let text;
  if (st.kind === "error") text = "Расписание: нет данных";
  else if (st.kind === "none") text = "Пар больше нет";
  else if (st.kind === "going") text = `${label(st.lesson)} до ${st.lesson.end}`;
  else if (st.kind === "break") text = `${label(st.lesson)} в ${st.lesson.start}`;
  else text = `${dayWord(st.lesson.date, now)} ${st.lesson.start} ${label(st.lesson)}`;
  w.addText(text);
}
