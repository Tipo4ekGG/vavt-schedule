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
ROOM_RE = re.compile(r"Ауд\.?\s*([\dА-Яа-яA-Za-z][\w.\-/ ]*?)\s*$")


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

    # 4) ячейки занятий, пересекающие столбец группы
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
        hits = [txt for c, txt in lesson_cells if _overlap(c[1], c[3], y0, y1)]
        if not hits:
            continue
        wd, dd, mm, note = dm.group(1), int(dm.group(2)), int(dm.group(3)), norm(dm.group(4))
        date = dt.date(year, mm, dd).isoformat()
        day = days.setdefault(date, {"date": date, "weekday": wd, "note": note or None, "lessons": []})
        for txt in hits:
            lesson = {"start": slot["start"], "end": slot["end"], **parse_lesson(txt)}
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
