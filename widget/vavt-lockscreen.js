// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: stopwatch;

// Расписание ВАВТ — виджет для экрана блокировки (Scriptable).
//  • идёт пара — отсчёт до её конца
//  • перемена — отсчёт до начала следующей пары
//  • всё остальное время (утром до первой пары, после пар, в выходные) —
//    арабское слово из словаря, каждые 15 минут новое
// Размеры: прямоугольный, круглый, строка над часами.

const DATA_URLS = [
  "https://raw.githubusercontent.com/Tipo4ekGG/vavt-schedule/main/data/schedule.json",
  "https://cdn.jsdelivr.net/gh/Tipo4ekGG/vavt-schedule@main/data/schedule.json",
];

// Словарь для слов после пар.
const DICT_URLS = [
  "https://raw.githubusercontent.com/Tipo4ekGG/arab/main/index.html",
  "https://cdn.jsdelivr.net/gh/Tipo4ekGG/arab@main/index.html",
];
const WORD_EVERY_MIN = 15;

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
//  going   — идёт пара, отсчёт до конца
//  break   — перемена, отсчёт до начала следующей
//  word    — до первой пары и после последней: арабское слово
function status(lessons, now) {
  const today = isoOf(now);
  const todays = lessons.filter((l) => l.date === today);
  const cur = todays.find((l) => l.from <= now && l.to > now);
  if (cur) return { kind: "going", target: cur.to, lesson: cur };
  const next = todays.find((l) => l.from > now);
  if (!next) return { kind: "word" };
  if (todays.some((l) => l.to <= now)) return { kind: "break", target: next.from, lesson: next };
  return { kind: "word" };
}

// Слова из таблиц словаря: первая ячейка class="ar", "tr" и "ru" в строке.
function parseWords(html) {
  const out = [], seen = {};
  const strip = (x) => x.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  for (const row of html.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
    const cells = [...row.matchAll(/<td class="(ar|tr|ru)"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => ({ k: m[1], v: strip(m[2]) }));
    const ar = cells.find((c) => c.k === "ar"), tr = cells.find((c) => c.k === "tr"), ru = cells.find((c) => c.k === "ru");
    if (!ar || !ru || !ar.v || !ru.v || /^ـ/.test(ar.v) || seen[ar.v]) continue;
    seen[ar.v] = 1;
    out.push({ ar: ar.v, tr: tr ? tr.v : "", ru: ru.v });
  }
  return out;
}

// Слово на текущие 15 минут: в пределах интервала одно и то же, потом следующее.
function wordFor(words, now) {
  if (!words.length) return null;
  const slot = Math.floor(now.getTime() / (WORD_EVERY_MIN * 60000));
  const i = ((slot * 2654435761) % 4294967296) % words.length;
  return words[i];
}

function dayWord(isoDay, now) {
  const d = toDate(isoDay, "00:00");
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((d - t) / 86400000);
  if (diff === 1) return "Завтра";
  return ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][d.getDay()];
}

function nextRefresh(st, now, lessons) {
  if (st.kind === "word") {
    // следующая смена слова; к полуночи — чтобы утром показать первую пару
    const step = WORD_EVERY_MIN * 60000;
    return new Date((Math.floor(now.getTime() / step) + 1) * step + 2000);
  }
  const in15 = new Date(now.getTime() + 15 * 60000);
  const min = new Date(now.getTime() + 60000);
  if (st.target && st.target < in15) return st.target > min ? st.target : min;
  return in15;
}

// ------------------------------------------------------------ Scriptable

if (typeof ListWidget === "undefined") {
  module.exports = { flatten, status, label, dayWord, nextRefresh, isoOf, parseWords, wordFor };
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

// Словарь кешируется и перекачивается не чаще раза в 6 часов.
async function loadWords() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.cacheDirectory(), "arab-words.json");
  const fresh = fm.fileExists(cache) && (Date.now() - fm.modificationDate(cache).getTime()) < 6 * 3600000;
  if (fresh) return JSON.parse(fm.readString(cache));
  for (const url of DICT_URLS) {
    try {
      const req = new Request(url + "?t=" + Date.now());
      req.timeoutInterval = 12;
      const words = parseWords(await req.loadString());
      if (words.length) {
        fm.writeString(cache, JSON.stringify(words));
        return words;
      }
    } catch (e) {}
  }
  return fm.fileExists(cache) ? JSON.parse(fm.readString(cache)) : [];
}

async function run() {
  const now = new Date();
  const family = config.widgetFamily || "accessoryRectangular";
  const data = await loadData();
  let st = data ? status(flatten(data), now) : { kind: "word" };
  if (st.kind === "word") {
    st.word = wordFor(await loadWords(), now);
    if (!st.word) st = { kind: data ? "none" : "error" };
  }

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
  if (st.kind === "word") return wordRect(w, st.word);
  const l = st.lesson;
  const top = w.addText(
    st.kind === "going" ? "До конца пары" :
    st.kind === "break" ? "До начала пары" :
    `Сегодня в ${l.start}`
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

function wordRect(w, word) {
  const a = w.addText(word.ar);
  a.font = Font.boldSystemFont(24);
  a.lineLimit = 1;
  a.minimumScaleFactor = 0.5;
  const r = w.addText(word.ru);
  r.font = Font.mediumSystemFont(13);
  r.lineLimit = 1;
  r.minimumScaleFactor = 0.8;
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
  if (st.kind === "word") {
    add(st.word.ar.split(" / ")[0], Font.boldSystemFont(18));
    return;
  }
  if (!st.target) {
    add("сегодня", Font.semiboldSystemFont(9), 0.75);
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
  else if (st.kind === "word") text = `${st.word.ar} — ${st.word.ru}`;
  else text = `${label(st.lesson)} в ${st.lesson.start}`;
  w.addText(text);
}
