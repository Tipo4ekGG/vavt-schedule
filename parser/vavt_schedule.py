"""Парсер расписания ВАВТ (vavt.ru/schedule) для одной группы.

Расписание публикуется еженедельными PDF, выгруженными из Excel. В таблице
общие пары (иностранный язык, лекции на поток) сделаны объединёнными ячейками,
поэтому парсер смотрит на геометрию ячеек: пара относится к группе, если
ячейка по горизонтали пересекает столбец группы, а по вертикали — строку пары.
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser

import pdfplumber

BASE = "https://www.vavt.ru"
UA = "Mozilla/5.0 (vavt-schedule widget; +https://github.com)"
WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
TIME_RE = re.compile(r"^(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})$")
DAY_RE = re.compile(r"^(Пн|Вт|Ср|Чт|Пт|Сб|Вс)\s+(\d{1,2})\.(\d{1,2})\s*(.*)$")
RANGE_RE = re.compile(r"(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})")
TYPE_RE = re.compile(r"\((л|с|пз|ПЗ|лаб|сем)\)", re.I)
GROUP_HDR_RE = re.compile(r"^Б\d+[А-ЯA-Z]*-[^.]+\.\d+$")
ROOM_RE =re.compile(r"Ауд\.?\s*([\dА-Яа-яA-Za-z][\w.\-/ ]*?)\s*$")


# ---------------------------------------------------------------- загрузка

def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def course_page_url(level: str, form: str, faculty: str, course: str) -> str:
    q = urllib.parse.urlencode({"f": level, "o": form, "n": faculty, "k": course})
    return f"{BASE}/schedule/?{q}"


class _WeeksParser(HTMLParser):
    """Достаёт со страницы курса блоки недель: диапазон дат, «текущая» ли, ссылки на PDF."""

    def __init__(self) -> None:
        super().__init__()
        self.weeks: list[dict] = []
        self._in_title = False
        self._link: dict | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class") or ""
        if tag == "div" and "_items_" in cls.split():
            self.weeks.append({"current": "two" in cls.split(), "title": "", "files": []})
        elif tag == "h2" and "title-box" in cls and self.weeks:
            self._in_title = True
        elif tag == "a" and self.weeks and (a.get("href") or "").startswith("/upload/schedule/"):
            self._link = {"href": a["href"], "text": ""}

    def handle_endtag(self, tag):
        if tag == "h2":
            self._in_title = False
        elif tag == "a" and self._link is not None:
            self.weeks[-1]["files"].append(self._link)
            self._link = None

    def handle_data(self, data):
        if self._in_title:
            self.weeks[-1]["title"] += data.strip()
        elif self._link is not None:
            self._link["text"] += data


def find_week_pdfs(page_html: str, profile: str) -> list[dict]:
    """Текущие недели (по разметке сайта) с PDF, где в имени файла есть профиль."""
    p = _WeeksParser()
    p.feed(page_html)
    out = []
    for w in p.weeks:
        if not w["current"]:
            continue
        m = RANGE_RE.search(w["title"])
        if not m:
            continue
        for f in w["files"]:
            name = urllib.parse.unquote(f["href"].split("?")[0].rsplit("/", 1)[-1])
            if profile.upper() in name.upper():
                href = f["href"]
                path, _, query = href.partition("?")
                url = BASE + urllib.parse.quote(path) + (f"?{query}" if query else "")
                version = re.search(r"Версия\s*(.+)$", f["text"].strip())
                out.append({
                    "start": m.group(1),
                    "end": m.group(2),
                    "url": url,
                    "file": name,
                    "version": version.group(1).strip() if version else None,
                })
    return out


# ---------------------------------------------------------------- разбор PDF

def norm(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def group_key(s: str) -> str:
    """«Б26М-ММВЯ.2», «Б26 -ИТУ.1» → без пробелов, верхний регистр."""
    return re.sub(r"\s+", "", s or "").upper()


def _overlap(a0, a1, b0, b1, frac=0.5) -> bool:
    inter = min(a1, b1) - max(a0, b0)
    return inter > frac * min(a1 - a0, b1 - b0)


def parse_lesson(text: str) -> dict:
    raw = norm(text)
    out = {"raw": raw, "title": raw, "kind": None, "teacher": None, "room": None}
    rest = raw
    room = ROOM_RE.search(rest)
    if room:
        out["room"] = room.group(1).strip()
        rest = rest[: room.start()].strip()
    t = TYPE_RE.search(rest)
    if t:
        out["kind"] = t.group(1).upper() if t.group(1).lower() == "пз" else t.group(1).lower()
        out["title"] = rest[: t.start()].strip()
        teacher = rest[t.end():].strip()
        out["teacher"] = teacher or None
    else:
        out["title"] = rest or raw
    return out


def parse_pdf(data: bytes, group: str, year: int) -> list[dict]:
    gkey = group_key(group)
    days: dict[str, dict] = {}
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            for table in page.find_tables():
                _parse_table(page, table, gkey, year, days)
    return sorted(days.values(), key=lambda d: d["date"])


def _parse_table(page, table, gkey: str, year: int, days: dict) -> None:
    cells = [c for c in table.cells]  # (x0, top, x1, bottom)
    chars = page.crop(table.bbox).chars

    def text_of(bbox):
        # Символ относится к ячейке, если заметно в неё заходит. Подпись, стоящая
        # на границе двух строк (визуально объединённая ячейка), достаётся обеим.
        x0, y0, x1, y1 = bbox
        got = []
        for ch in chars:
            h = ch["bottom"] - ch["top"] or 1
            w = ch["x1"] - ch["x0"] or 1
            vy = min(y1, ch["bottom"]) - max(y0, ch["top"])
            vx = min(x1, ch["x1"]) - max(x0, ch["x0"])
            if vy >= 0.3 * h and vx >= 0.5 * w:
                got.append(ch)
        return norm(pdfplumber.utils.extract_text(got)) if got else ""

    # 1) столбец группы
    gcol = None
    for c in cells:
        if group_key(text_of(c)) == gkey:
            gcol = (c[0], c[2])
            break
    if gcol is None:
        return

    # 2) строки пар: ячейка со временем «09.00-10.20» даёт вертикальный интервал и столбец времени
    slots = []
    time_x = None
    for c in cells:
        t = text_of(c)
        m = TIME_RE.match(t)
        if m and (c[2] - c[0]) < (gcol[1] - gcol[0]) * 3:
            slots.append({
                "y": (c[1], c[3]),
                "start": f"{int(m.group(1)):02d}:{m.group(2)}",
                "end": f"{int(m.group(3)):02d}:{m.group(4)}",
            })
            time_x = c[2] if time_x is None else max(time_x, c[2])
    if not slots:
        return

    # 3) дни: ячейки левее столбца времени с «Пн 26.10 ...»
    day_cells = []
    for c in cells:
        if c[2] <= (time_x or 0) + 1 and c[0] < (time_x or 0):
            m = DAY_RE.match(text_of(c))
            if m:
                day_cells.append((c, m))

    day_cells.sort(key=lambda cm: cm[0][1])

    def day_for(y0, y1):
        # День — ближайшая подпись дня, начинающаяся не ниже строки пары:
        # столбец дня бывает разбит на несколько ячеек.
        found = None
        for c, m in day_cells:
            if c[1] <= y0 + 1 or _overlap(c[1], c[3], y0, y1):
                found = m
        return found

    # 4) столбцы всех групп таблицы — чтобы понимать, на сколько групп растянута ячейка
    group_cols = []
    for c in cells:
        if GROUP_HDR_RE.match(group_key(text_of(c))):
            group_cols.append((c[0], c[2]))

    def span_of(c):
        return sum(1 for g in group_cols if _overlap(c[0], c[2], g[0], g[1]))

    other_cells = [
        (c, parse_lesson(text_of(c)))
        for c in cells
        if c[0] >= (time_x or 0) - 1 and not _overlap(c[0], c[2], gcol[0], gcol[1])
    ]

    def fix_kind(cell, lesson):
        """«(л)» в ячейке одной группы, если ни у кого больше в это время нет такой же лекции, — на деле семинар."""
        if lesson["kind"] != "л" or len(group_cols) < 2 or span_of(cell) > 1:
            return lesson
        for oc, ol in other_cells:
            if _overlap(oc[1], oc[3], cell[1], cell[3]) and ol["kind"] == "л" and ol["title"] == lesson["title"]:
                return lesson
        lesson = dict(lesson)
        lesson["kind"] = "с"
        lesson["kind_fixed"] = "в файле стояло (л), но лекции у других групп в это время нет"
        lesson["raw"] = re.sub(r"\(л\)", "(с)", lesson["raw"], count=1)
        return lesson

    # 5) ячейки занятий, пересекающие столбец группы
    lesson_cells = []
    for c in cells:
        if c[0] < (time_x or 0) - 1:
            continue
        if not _overlap(c[0], c[2], gcol[0], gcol[1]):
            continue
        txt = text_of(c)
        if not txt or group_key(txt) == gkey:
            continue
        lesson_cells.append((c, txt))

    for slot in slots:
        y0, y1 = slot["y"]
        dm = day_for(y0, y1)
        if not dm:
            continue
        hits = [(c, txt) for c, txt in lesson_cells if _overlap(c[1], c[3], y0, y1)]
        if not hits:
            continue
        wd, dd, mm, note = dm.group(1), int(dm.group(2)), int(dm.group(3)), norm(dm.group(4))
        date = dt.date(year, mm, dd).isoformat()
        day = days.setdefault(date, {"date": date, "weekday": wd, "note": note or None, "lessons": []})
        for c, txt in hits:
            lesson = {"start": slot["start"], "end": slot["end"], **fix_kind(c, parse_lesson(txt))}
            if lesson not in day["lessons"]:
                day["lessons"].append(lesson)
        day["lessons"].sort(key=lambda l: l["start"])


# ---------------------------------------------------------------- вывод

def as_text(result: dict) -> str:
    lines = []
    for week in result["weeks"]:
        s, e = week["start"][:5], week["end"][:5]
        lines.append(f"📅 {result['group']} | {s} — {e}")
        lines.append("➖" * 10)
        for day in week["days"]:
            d = dt.date.fromisoformat(day["date"])
            head = f"📌 {day['weekday']} {d:%d.%m}"
            if day.get("note"):
                head += f" {day['note']}"
            lines += ["", head]
            for l in day["lessons"]:
                lines.append(f"   🕒 {l['start'].replace(':', '.')}-{l['end'].replace(':', '.')} — {l['raw']}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def build(group: str, level: str, form: str, faculty: str, course: str, profile: str) -> dict:
    page_url = course_page_url(level, form, faculty, course)
    html = http_get(page_url).decode("utf-8", "replace")
    weeks = []
    for w in find_week_pdfs(html, profile):
        year = int(w["start"][-4:])
        days = parse_pdf(http_get(w["url"]), group, year)
        weeks.append({**w, "days": days})
    weeks.sort(key=lambda w: dt.datetime.strptime(w["start"], "%d.%m.%Y"))
    return {
        "group": group,
        "source": page_url,
        "weeks": weeks,
    }


# ---------------------------------------------------------------- изменения

KEEP_CHANGES_DAYS = 3


def msk_now() -> dt.datetime:
    from zoneinfo import ZoneInfo
    return dt.datetime.now(ZoneInfo("Europe/Moscow"))


def _lessons_by_date(result: dict, week_starts: set) -> dict:
    out = {}
    for w in result.get("weeks", []):
        if w.get("start") not in week_starts:
            continue
        for d in w.get("days", []):
            out[d["date"]] = d["lessons"]
    return out


def diff_lessons(date: str, old: list, new: list) -> list:
    """Что поменялось за день: перенос, аудитория, тип занятия, отмена, добавление."""
    out = []
    old = list(old)
    new = list(new)

    def base(change, title):
        return {"date": date, "change": change, "title": title}

    # 1) та же пара в то же время — сравнить аудиторию и тип
    for n in list(new):
        o = next((x for x in old if x["start"] == n["start"] and x["title"] == n["title"]), None)
        if not o:
            continue
        old.remove(o)
        new.remove(n)
        if (o.get("room") or "") != (n.get("room") or ""):
            out.append({**base("room", n["title"]), "kind": n.get("kind"), "start": n["start"],
                        "room_before": o.get("room"), "room_after": n.get("room")})
        if (o.get("kind") or "") != (n.get("kind") or ""):
            out.append({**base("type", n["title"]), "start": n["start"],
                        "kind_before": o.get("kind"), "kind_after": n.get("kind")})
    # 2) та же дисциплина в другое время — перенос
    for n in list(new):
        o = next((x for x in old if x["title"] == n["title"] and x.get("kind") == n.get("kind")), None) \
            or next((x for x in old if x["title"] == n["title"]), None)
        if not o:
            continue
        old.remove(o)
        new.remove(n)
        out.append({**base("moved", n["title"]), "kind": n.get("kind"),
                    "start_before": o["start"], "start": n["start"],
                    "room_before": o.get("room"), "room_after": n.get("room")})
    # 3) остальное — отменено / добавлено
    for o in old:
        out.append({**base("cancelled", o["title"]), "kind": o.get("kind"), "start_before": o["start"]})
    for n in new:
        out.append({**base("added", n["title"]), "kind": n.get("kind"), "start": n["start"], "room_after": n.get("room")})
    return out


def find_changes(old: dict, new: dict) -> list:
    """Сравнивает только недели, которые есть и в старой, и в новой версии."""
    common = {w["start"] for w in old.get("weeks", [])} & {w["start"] for w in new.get("weeks", [])}
    # неделя, которая внезапно разобралась пустой, — скорее сбой разбора, а не отмена всех пар
    for w in new.get("weeks", []):
        if w["start"] in common and not w.get("days"):
            common.discard(w["start"])
    o, n = _lessons_by_date(old, common), _lessons_by_date(new, common)
    out = []
    for date in sorted(set(o) | set(n)):
        out += diff_lessons(date, o.get(date, []), n.get(date, []))
    return out


def merge_changes(old: dict, new: dict, now: dt.datetime) -> list:
    """Старые изменения (свежие и на будущие дни) + новые, без повторов."""
    today = now.date().isoformat()
    since = now - dt.timedelta(days=KEEP_CHANGES_DAYS)
    kept = []
    for c in old.get("changes", []):
        try:
            seen = dt.datetime.fromisoformat(c["detected"])
        except (KeyError, ValueError):
            continue
        if c["date"] >= today and seen >= since:
            kept.append(c)
    stamp = now.isoformat(timespec="minutes")
    key = lambda c: json.dumps({k: v for k, v in c.items() if k != "detected"}, ensure_ascii=False, sort_keys=True)
    have = {key(c) for c in kept}
    for c in find_changes(old, new):
        if c["date"] >= today and key(c) not in have:
            kept.append({**c, "detected": stamp})
            have.add(key(c))
    kept.sort(key=lambda c: (c["date"], c.get("start") or c.get("start_before") or ""))
    return kept


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--group", default="Б26М-ММВЯ.2")
    ap.add_argument("--level", default="Бакалавриат")
    ap.add_argument("--form", default="Очная форма обучения")
    ap.add_argument("--faculty", default="ФВМ")
    ap.add_argument("--course", default="1 курс")
    ap.add_argument("--profile", default="ММВЯ", help="кусок имени PDF-файла, по которому выбирается файл")
    ap.add_argument("--pdf", help="разобрать локальный PDF вместо загрузки с сайта")
    ap.add_argument("--year", type=int, default=dt.date.today().year)
    ap.add_argument("--json", help="куда записать JSON")
    ap.add_argument("--text", help="куда записать текстовую версию")
    a = ap.parse_args(argv)

    if a.pdf:
        with open(a.pdf, "rb") as f:
            days = parse_pdf(f.read(), a.group, a.year)
        result = {"group": a.group, "weeks": [{
            "start": days[0]["date"] if days else "", "end": days[-1]["date"] if days else "",
            "days": days}]}
        if days:
            for k in ("start", "end"):
                d = dt.date.fromisoformat(result["weeks"][0][k])
                result["weeks"][0][k] = f"{d:%d.%m.%Y}"
    else:
        result = build(a.group, a.level, a.form, a.faculty, a.course, a.profile)

    if not any(w["days"] for w in result["weeks"]):
        print("Не нашёл ни одной пары — проверь группу/курс или вёрстку сайта", file=sys.stderr)
        return 1

    text = as_text(result)
    if a.json:
        try:
            with open(a.json, encoding="utf-8") as f:
                previous = json.load(f)
        except (OSError, ValueError):
            previous = {}
        if previous.get("group") == result["group"]:
            result["changes"] = merge_changes(previous, result, msk_now())
        else:
            result["changes"] = []
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
            f.write("\n")
    if a.text:
        with open(a.text, "w", encoding="utf-8") as f:
            f.write(text)
    if not a.json and not a.text:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
