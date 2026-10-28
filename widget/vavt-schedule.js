// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: calendar-alt;

// Расписание ВАВТ — виджет для Scriptable.
// Данные готовит GitHub Actions (папка parser/ в репозитории) и кладёт в data/schedule.json.
// Параметр виджета (долгое нажатие → Изменить виджет → Parameter) можно не задавать.
//   "next"  — следующая пара крупно (по умолчанию для маленького виджета)
//   "today" — список пар на сегодня (по умолчанию для среднего)
//   "week"  — вся неделя в два столбца (по умолчанию для большого)

// Основной адрес и запасной (jsDelivr) — на случай, если GitHub недоступен у провайдера.
const DATA_URLS = [
  "https://raw.githubusercontent.com/Tipo4ekGG/vavt-schedule/main/data/schedule.json",
  "https://cdn.jsdelivr.net/gh/Tipo4ekGG/vavt-schedule@main/data/schedule.json",
];

// Словарь — для «Фразы дня».
const DICT_URLS = [
  "https://raw.githubusercontent.com/Tipo4ekGG/arab/main/index.html",
  "https://cdn.jsdelivr.net/gh/Tipo4ekGG/arab@main/index.html",
];

// Пары, которые не показывать (ищется по началу названия). Допиши сюда, если что-то ещё не нужно.
const HIDE = ["Русский как иностранный"];

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
        if (HIDE.some((h) => (l.title || l.raw || "").startsWith(h))) continue;
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
  // момент переключения недели (суббота 18:00)
  const sw = new Date(now.getFullYear(), now.getMonth(), now.getDate(), SWITCH_HOUR, 0);
  sw.setDate(sw.getDate() + ((SWITCH_WEEKDAY - now.getDay() + 7) % 7));
  if (sw > now) marks.push(sw);
  marks.sort((a, b) => a - b);
  // данные на GitHub проверяются раз в 15 минут — виджет просит обновление не реже
  const soon = new Date(now.getTime() + 5 * 60000);
  const later = new Date(now.getTime() + 15 * 60000);
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

// Короткие названия для недельного вида (ищется по началу названия).
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

// Тип занятия в скобках, как в расписании вуза: (л), (с), (ПЗ).
function withKind(title, kind) {
  return kind ? `${title} (${kind})` : title;
}

function shortTitle(title) {
  for (const [from, to] of SHORT) if (title.startsWith(from)) return to;
  return title;
}

// Когда переключаться на следующую неделю: суббота, 18:00.
const SWITCH_WEEKDAY = 6;
const SWITCH_HOUR = 18;

function parseRu(s) {
  const [d, m, y] = s.split(".").map(Number);
  return new Date(y, m - 1, d);
}

// Текущая неделя; с субботы 18:00 до конца воскресенья — следующая.
function weekView(data, now) {
  const lessons = flatten(data);
  const weeks = data.weeks || [];
  const ref = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const wd = now.getDay();
  if ((wd === SWITCH_WEEKDAY && now.getHours() >= SWITCH_HOUR) || wd === 0) {
    ref.setDate(ref.getDate() + ((8 - wd) % 7 || 7)); // ближайший понедельник
  }
  let week =
    weeks.find((w) => parseRu(w.start) <= ref && ref <= parseRu(w.end)) ||
    weeks.find((w) => parseRu(w.start) > ref) ||
    weeks[weeks.length - 1];
  if (!week) return null;
  const days = (week.days || [])
    .map((day) => ({
      ...day,
      items: lessons.filter((x) => x.date === day.date).map((l) => ({ ...l, short: shortTitle(l.title) })),
    }))
    .filter((d) => d.items.length);
  return { start: week.start, end: week.end, days };
}

// Изменения в расписании на сегодня и дальше (парсер хранит их 3 дня).
function activeChanges(data, now) {
  const today = isoOf(now);
  return (data.changes || []).filter((ch) =>
    ch.date >= today && !HIDE.some((h) => (ch.title || "").startsWith(h)));
}

const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function changeText(ch) {
  const d = toDate(ch.date, "00:00");
  const day = `${WD_SHORT[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  const t = shortTitle(ch.title);
  const tk = withKind(t, ch.kind);
  switch (ch.change) {
    case "moved": return `${day} · ${tk}: ${ch.start_before} → ${ch.start}`;
    case "room": return `${day} · ${tk}: ауд. ${ch.room_before || "—"} → ${ch.room_after || "—"}`;
    case "type": return `${day} · ${t}: (${ch.kind_before || "?"}) → (${ch.kind_after || "?"})`;
    case "cancelled": return `${day} · ${tk} в ${ch.start_before} отменена`;
    case "added": return `${day} · ${tk} в ${ch.start} — новая`;
    default: return `${day} · ${t}`;
  }
}

// Пара, которой касается изменение, — чтобы подсветить её в неделе.
function isChanged(changes, l) {
  return changes.some((ch) => ch.date === l.date && ch.start === l.start && ch.title === l.title);
}

// Фразы из таблиц словаря с заголовком «Фраза».
function parsePhrases(html) {
  const out = [];
  const strip = (x) => x.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) || []) {
    const head = (table.match(/<th>([\s\S]*?)<\/th>/) || [])[1];
    if (!head || strip(head) !== "Фраза") continue;
    for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
      const ar = (row.match(/<td class="ar"[^>]*>([\s\S]*?)<\/td>/) || [])[1];
      const ru = (row.match(/<td class="ru"[^>]*>([\s\S]*?)<\/td>/) || [])[1];
      const tr = (row.match(/<td class="tr"[^>]*>([\s\S]*?)<\/td>/) || [])[1];
      if (ar && ru) out.push({ ar: strip(ar), tr: tr ? strip(tr) : "", ru: strip(ru) });
    }
  }
  return out;
}

// Фраза дня меняется в PHRASE_HOUR ночи: до этого часа ещё «вчерашняя».
const PHRASE_HOUR = 4;
function phraseFor(phrases, now) {
  if (!phrases.length) return null;
  const t = new Date(now.getTime() - PHRASE_HOUR * 3600000);
  const day = Math.floor(new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() / 86400000);
  return phrases[((day * 2654435761) % 4294967296) % phrases.length];
}

// Высоты в пунктах, замерены по скриншоту большого виджета.
const FIT = { avail: 305, row: 16.5, card: 26, past: 24, gap: 9, phrase: 72 };

function colHeight(days) {
  return days.reduce((s, d, i) => s + (i ? FIT.gap : 0) + (d.collapsed ? FIT.past : FIT.card + FIT.row * d.items.length), 0);
}

// Сворачивать прошедшие дни (начиная с самых старых), только если неделя не влезает.
function fitWeek(days, today) {
  days.forEach((d) => (d.collapsed = false));
  const fits = () => {
    const [a, b] = splitColumns(days);
    const ha = colHeight(a), hb = colHeight(b);
    // под коротким столбцом стоит карточка фразы/изменений
    return Math.max(ha, hb) <= FIT.avail && Math.min(ha, hb) + FIT.gap + FIT.phrase <= FIT.avail;
  };
  for (const d of days) {
    if (fits()) break;
    if (d.date < today) d.collapsed = true;
  }
  return days;
}

// Делит дни на два столбца так, чтобы по высоте (строки + заголовки) они были примерно равны.
function splitColumns(days) {
  const h = (d) => (d.collapsed ? 1 : d.items.length + 1.4);
  const total = days.reduce((s, d) => s + h(d), 0);
  let acc = 0, cut = days.length;
  for (let i = 0; i < days.length; i++) {
    if (acc + h(days[i]) / 2 > total / 2) { cut = i; break; }
    acc += h(days[i]);
  }
  if (cut === 0) cut = 1;
  return [days.slice(0, cut), days.slice(cut)];
}

// ------------------------------------------------------------ Scriptable

if (typeof ListWidget === "undefined") {
  module.exports = { fitWeek, colHeight, activeChanges, changeText, isChanged, parsePhrases, phraseFor, withKind, flatten, upcoming, dayToShow, relTime, dayTitle, nextRefresh, meta, asText, toDate, isoOf, weekView, splitColumns, shortTitle };
} else {
  await run();
}

async function loadData() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.cacheDirectory(), "vavt-schedule.json");
  const errors = [];
  for (const url of DATA_URLS) {
    try {
      const req = new Request(url + "?t=" + Date.now());
      req.timeoutInterval = 12;
      const data = await req.loadJSON();
      if (!data || !data.weeks) throw new Error(`пустой ответ (HTTP ${req.response && req.response.statusCode})`);
      fm.writeString(cache, JSON.stringify(data));
      return { data, stale: false };
    } catch (e) {
      errors.push(`${url.split("/")[2]}: ${e.message || e}`);
    }
  }
  if (fm.fileExists(cache)) return { data: JSON.parse(fm.readString(cache)), stale: true };
  throw new Error(errors.join("\n"));
}

// Фразы словаря; перекачиваются не чаще раза в сутки.
async function loadPhrases() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.cacheDirectory(), "arab-phrases-v2.json");
  const fresh = fm.fileExists(cache) && (Date.now() - fm.modificationDate(cache).getTime()) < 24 * 3600000;
  if (fresh) return JSON.parse(fm.readString(cache));
  for (const url of DICT_URLS) {
    try {
      const req = new Request(url + "?t=" + Date.now());
      req.timeoutInterval = 12;
      const list = parsePhrases(await req.loadString());
      if (list.length) {
        fm.writeString(cache, JSON.stringify(list));
        return list;
      }
    } catch (e) {}
  }
  return fm.fileExists(cache) ? JSON.parse(fm.readString(cache)) : [];
}

function colors() {
  return {
    bg: Color.dynamic(new Color("#F4F1EA"), new Color("#16181D")),
    text: Color.dynamic(new Color("#1B1B1F"), new Color("#F2F2F4")),
    dim: Color.dynamic(new Color("#6B6B73"), new Color("#9A9AA5")),
    accent: Color.dynamic(new Color("#B23A2E"), new Color("#F07A6A")),
    now: Color.dynamic(new Color("#1F6F5C"), new Color("#5BD1B0")),
    card: Color.dynamic(new Color("#FFFFFF", 0.75), new Color("#FFFFFF", 0.06)),
    todayBg: Color.dynamic(new Color("#B23A2E", 0.07), new Color("#F07A6A", 0.08)),
    todayBorder: Color.dynamic(new Color("#B23A2E", 0.55), new Color("#F07A6A", 0.6)),
  };
}

async function run() {
  const now = new Date();
  const family = config.widgetFamily || (config.runsInApp ? "large" : "medium");
  const param = (args.widgetParameter || "").trim().toLowerCase();
  const mode = param || (family === "small" ? "next" : family === "large" ? "week" : "today");
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
    return finish(w, null, family);
  }

  const lessons = flatten(data);
  w.refreshAfterDate = nextRefresh(lessons, now);
  w.url = data.source || "https://www.vavt.ru/schedule/";

  if (mode === "next") renderNext(w, lessons, now, c, data);
  else if (mode === "week") {
    const changes = activeChanges(data, now);
    const phrase = changes.length ? null : phraseFor(await loadPhrases(), now);
    renderWeek(w, now, c, data, family, changes, phrase);
  }
  else renderDay(w, lessons, now, c, data, family);

  if (stale) {
    w.addSpacer(2);
    const s = w.addText("нет сети — показан кеш");
    s.font = Font.systemFont(9); s.textColor = c.dim;
  }
  return finish(w, asText(lessons, now), family);
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
    const t = col.addText(withKind(l.title, l.kind));
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

function renderWeek(w, now, c, data, family, changes = [], phrase = null) {
  const week = weekView(data, now);
  if (!week || !week.days.length) {
    header(w, data.group, null, c);
    w.addSpacer();
    const t = w.addText("Пар на неделе нет");
    t.font = Font.semiboldSystemFont(14); t.textColor = c.text;
    w.addSpacer();
    return;
  }
  w.setPadding(14, 12, 12, 12);
  header(w, `${week.start.slice(0, 5)} — ${week.end.slice(0, 5)}`, data.group.replace(/^Б\d+М-/, ""), c);
  w.addSpacer(8);

  const today = isoOf(now);
  const two = family === "large" || family === "extraLarge";
  if (two) fitWeek(week.days, today);
  const cols = two ? splitColumns(week.days) : [week.days];
  const row = w.addStack();
  row.topAlignContent();
  // отсчёт ставим под более короткий столбец (обычно — под субботой)
  const heightOf = (days) => days.reduce((s, d) => s + (d.collapsed ? 1 : d.items.length + 1.4), 0);
  const shortest = cols.length > 1 && heightOf(cols[1]) <= heightOf(cols[0]) ? 1 : 0;

  cols.forEach((days, i) => {
    if (i > 0) row.addSpacer(6);
    const col = row.addStack();
    col.layoutVertically();
    days.forEach((day, j) => {
      if (j > 0) col.addSpacer(9);
      if (day.collapsed) pastCard(col, day, c);
      else dayCard(col, day, today, now, c, changes);
    });
    if (i === shortest) {
      if (changes.length) changesCard(col, changes, c);
      else if (phrase) phraseCard(col, phrase, c);
    }
  });
  w.addSpacer();
}

// Сводка изменений: до 3 строк, остальное — «ещё N».
function changesCard(col, changes, c) {
  col.addSpacer(8);
  const box = col.addStack();
  box.layoutVertically();
  box.setPadding(7, 7, 8, 6);
  box.cornerRadius = 10;
  box.backgroundColor = c.todayBg;

  const head = box.addText("Изменения в расписании");
  head.font = Font.boldSystemFont(11);
  head.textColor = c.accent;
  head.lineLimit = 1;

  const MAX = 3;
  const shown = changes.length > MAX ? changes.slice(0, MAX - 1) : changes;
  for (const ch of shown) {
    box.addSpacer(3);
    const t = box.addText(changeText(ch));
    t.font = Font.mediumSystemFont(11);
    t.textColor = c.text;
    t.lineLimit = 2;
  }
  if (changes.length > shown.length) {
    box.addSpacer(3);
    const more = box.addText(`ещё ${changes.length - shown.length}`);
    more.font = Font.systemFont(10);
    more.textColor = c.dim;
  }
}

// Арабская фраза дня из словаря — по центру, как открытка.
function centered(box, text, font, color) {
  const r = box.addStack();
  r.addSpacer();
  const t = r.addText(text);
  t.font = font;
  t.textColor = color;
  t.lineLimit = 2;
  t.centerAlignText();
  r.addSpacer();
  return t;
}

function phraseCard(col, phrase, c) {
  col.addSpacer(9);
  const box = col.addStack();
  box.layoutVertically();
  box.setPadding(8, 8, 10, 8);
  box.cornerRadius = 10;
  box.backgroundColor = c.card;
  centered(box, "ФРАЗА ДНЯ", Font.semiboldSystemFont(9), c.dim);
  box.addSpacer(2);
  // Geeza Pro — встроенный арабский шрифт iOS: огласовки в нём не слипаются, в отличие от системного.
  // Огласовки выше строки — даём ей запас сверху, иначе шадда и фатха обрезаются.
  const arRow = box.addStack();
  arRow.setPadding(7, 0, 1, 0);
  arRow.addSpacer();
  const a = arRow.addText(phrase.ar);
  a.font = new Font("GeezaPro-Bold", 19);
  a.textColor = c.text;
  a.lineLimit = 2;
  a.centerAlignText();
  arRow.addSpacer();
  if (phrase.tr) {
    box.addSpacer(2);
    centered(box, phrase.tr, Font.italicSystemFont(11), c.text);
  }
  box.addSpacer(2);
  centered(box, phrase.ru, Font.systemFont(11), c.dim);
}

// Прошедший день — одной строкой.
function pastCard(col, day, c) {
  const d = toDate(day.date, "00:00");
  const card = col.addStack();
  card.setPadding(6, 8, 6, 7);
  card.cornerRadius = 10;
  card.backgroundColor = c.card;
  card.centerAlignContent();
  const wd = card.addText(day.weekday.toUpperCase());
  wd.font = Font.heavySystemFont(12);
  wd.textColor = c.dim;
  card.addSpacer(5);
  const dt = card.addText(`${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`);
  dt.font = Font.mediumSystemFont(11);
  dt.textColor = c.dim;
  card.addSpacer();
  const n = day.items.length;
  const x = n % 10, y = n % 100;
  const word = x === 1 && y !== 11 ? "пара" : x >= 2 && x <= 4 && (y < 12 || y > 14) ? "пары" : "пар";
  const t = card.addText(`${n} ${word} ✓`);
  t.font = Font.mediumSystemFont(10);
  t.textColor = c.dim;
}

function dayCard(col, day, today, now, c, changes = []) {
  const isToday = day.date === today;
  const past = day.date < today;
  const d = toDate(day.date, "00:00");

  const card = col.addStack();
  card.layoutVertically();
  card.setPadding(7, 8, 8, 7);
  card.cornerRadius = 10;
  card.backgroundColor = isToday ? c.todayBg : c.card;
  if (isToday) {
    card.borderColor = c.todayBorder;
    card.borderWidth = 1.5;
  }

  const head = card.addStack();
  head.centerAlignContent();
  const wd = head.addText(day.weekday.toUpperCase());
  wd.font = Font.heavySystemFont(12);
  wd.textColor = isToday ? c.accent : past ? c.dim : c.text;
  head.addSpacer(5);
  const dt = head.addText(`${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`);
  dt.font = Font.mediumSystemFont(11);
  dt.textColor = c.dim;
  head.addSpacer();
  if (day.note) {
    const n = head.addText(day.note);
    n.font = Font.mediumSystemFont(9);
    n.textColor = c.dim;
  }
  card.addSpacer(5);

  day.items.forEach((l, k) => {
    if (k > 0) card.addSpacer(4);
    const done = l.to <= now;
    const going = l.from <= now && !done;
    const line = card.addStack();
    line.centerAlignContent();
    const t = line.addText(l.start);
    t.font = Font.mediumMonospacedSystemFont(10.5);
    const changed = isChanged(changes, l);
    t.textColor = going ? c.now : changed ? c.accent : c.dim;
    line.addSpacer(4);
    const name = line.addText(withKind(l.short, l.kind));
    name.font = Font.mediumSystemFont(12);
    name.textColor = going ? c.now : changed ? c.accent : done ? c.dim : c.text;
    name.lineLimit = 1;
    line.addSpacer();
    if (l.room) {
      line.addSpacer(3);
      const r = line.addText(l.room);
      r.font = Font.systemFont(9);
      r.textColor = c.dim;
      r.lineLimit = 1;
    }
  });
}

async function finish(w, text, family) {
  const preview = () => (family === "large" ? w.presentLarge() : family === "small" ? w.presentSmall() : w.presentMedium());
  if (config.runsInWidget) {
    Script.setWidget(w);
  } else if (text !== null && config.runsInApp && !args.widgetParameter) {
    // Запуск из приложения: превью виджета + вся неделя текстом.
    await preview();
    const a = new Alert();
    a.title = "Расписание";
    a.message = text || "Пар нет";
    a.addAction("OK");
    await a.present();
  } else {
    await preview();
  }
  Script.complete();
}
