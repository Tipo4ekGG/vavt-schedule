// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: list-ul;

// Расписание ВАВТ — пары на сегодня для экрана блокировки (Scriptable).
// Прямоугольный: оставшиеся пары (прошедшие пропадают, идущая отмечена ●).
// Когда на сегодня всё — ближайший учебный день.
// Круглый: сколько пар осталось. Строка над часами: до скольких сегодня пары.

const DATA_URLS = [
  "https://raw.githubusercontent.com/Tipo4ekGG/vavt-schedule/main/data/schedule.json",
  "https://cdn.jsdelivr.net/gh/Tipo4ekGG/vavt-schedule@main/data/schedule.json",
];

const HIDE = ["Русский как иностранный"];

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

const MAX_LINES = 3;

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

// Какой день показать и какие пары в нём ещё не закончились.
function dayView(lessons, now) {
  const left = lessons.filter((l) => l.to > now);
  if (!left.length) return null;
  const date = left[0].date;
  return {
    date,
    isToday: date === isoOf(now),
    total: lessons.filter((l) => l.date === date).length,
    items: left.filter((l) => l.date === date).map((l) => ({ ...l, going: l.from <= now })),
  };
}

function dayTitle(isoDay, now) {
  const d = toDate(isoDay, "00:00");
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((d - t) / 86400000);
  const dm = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  if (diff === 0) return "Сегодня";
  if (diff === 1) return `Завтра, ${dm}`;
  return `${["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][d.getDay()]}, ${dm}`;
}

function pairsWord(n) {
  const x = n % 10, y = n % 100;
  if (x === 1 && y !== 11) return "пара";
  if (x >= 2 && x <= 4 && (y < 12 || y > 14)) return "пары";
  return "пар";
}

// Обновиться, когда закончится ближайшая пара (она пропадёт из списка) или начнётся следующая.
function nextRefresh(lessons, now) {
  const marks = [];
  for (const l of lessons) {
    if (l.from > now) marks.push(l.from);
    if (l.to > now) marks.push(l.to);
  }
  marks.sort((a, b) => a - b);
  const in15 = new Date(now.getTime() + 15 * 60000);
  const min = new Date(now.getTime() + 60000);
  const t = marks[0] && marks[0] < in15 ? marks[0] : in15;
  return t < min ? min : t;
}

// ------------------------------------------------------------ Scriptable

if (typeof ListWidget === "undefined") {
  module.exports = { flatten, dayView, dayTitle, label, pairsWord, nextRefresh };
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
  const lessons = data ? flatten(data) : [];
  const view = data ? dayView(lessons, now) : null;

  const w = new ListWidget();
  w.refreshAfterDate = nextRefresh(lessons, now);

  if (!data) w.addText("Нет данных расписания").font = Font.semiboldSystemFont(12);
  else if (family === "accessoryInline") inline(w, view, now);
  else if (family === "accessoryCircular") circular(w, view, now);
  else rectangular(w, view, now);

  if (config.runsInAccessoryWidget || config.runsInWidget) Script.setWidget(w);
  else await w.presentAccessoryRectangular();
  Script.complete();
}

function rectangular(w, view, now) {
  w.setPadding(0, 0, 0, 0);
  if (!view) {
    w.addText("Пар нет").font = Font.semiboldSystemFont(14);
    return;
  }
  const head = w.addText(dayTitle(view.date, now));
  head.font = Font.semiboldSystemFont(11);
  head.textOpacity = 0.75;

  const extra = view.items.length - MAX_LINES;
  const shown = view.items.slice(0, extra > 0 ? MAX_LINES - 1 : MAX_LINES);
  for (const l of shown) {
    const row = w.addStack();
    row.centerAlignContent();
    const t = row.addText(l.going ? `● ${l.start}` : l.start);
    t.font = Font.boldMonospacedSystemFont(12);
    row.addSpacer(5);
    const n = row.addText(label(l));
    n.font = l.going ? Font.boldSystemFont(12) : Font.mediumSystemFont(12);
    n.lineLimit = 1;
    row.addSpacer();
    if (l.room) {
      row.addSpacer(3);
      const r = row.addText(l.room);
      r.font = Font.systemFont(10);
      r.textOpacity = 0.75;
    }
  }
  if (extra > 0) {
    const more = w.addText(`ещё ${extra + 1} · до ${view.items[view.items.length - 1].end}`);
    more.font = Font.systemFont(10);
    more.textOpacity = 0.75;
  }
  w.addSpacer();
}

function circular(w, view, now) {
  w.addAccessoryWidgetBackground = true;
  const s = w.addStack();
  s.layoutVertically();
  const line = (text, font, op) => {
    const r = s.addStack();
    r.addSpacer();
    const t = r.addText(text);
    t.font = font;
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.6;
    if (op) t.textOpacity = op;
    r.addSpacer();
  };
  if (!view) { line("—", Font.boldSystemFont(18)); return; }
  const n = view.items.length;
  line(String(n), Font.boldRoundedSystemFont(22));
  line(view.isToday ? pairsWord(n) : dayTitle(view.date, now).split(",")[0].toLowerCase(), Font.semiboldSystemFont(10), 0.75);
}

function inline(w, view, now) {
  if (!view) { w.addText("Пар нет"); return; }
  const n = view.items.length, last = view.items[n - 1];
  if (view.isToday) w.addText(`Ещё ${n} ${pairsWord(n)} · до ${last.end}`);
  else w.addText(`${dayTitle(view.date, now)}: с ${view.items[0].start} до ${last.end}`);
}
