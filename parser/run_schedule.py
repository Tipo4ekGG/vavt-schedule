"""Совместимый запуск парсера после изменения разметки страницы расписания ВАВТ.

ВАВТ перестал помечать актуальные блоки недели CSS-классом `two`.
Основной парсер раньше использовал именно этот класс и поэтому не выбирал
ни одного PDF. Здесь выбор недели делается по датам, а остальная логика
остаётся в vavt_schedule.py.
"""

from __future__ import annotations

import datetime as dt
import re
import urllib.parse

import vavt_schedule as base


def find_week_pdfs(page_html: str, profile: str) -> list[dict]:
    p = base._WeeksParser()
    p.feed(page_html)

    candidates = []
    for w in p.weeks:
        m = base.RANGE_RE.search(w["title"])
        if not m:
            continue

        start = dt.datetime.strptime(m.group(1), "%d.%m.%Y").date()
        end = dt.datetime.strptime(m.group(2), "%d.%m.%Y").date()

        for f in w["files"]:
            name = urllib.parse.unquote(f["href"].split("?")[0].rsplit("/", 1)[-1])
            if profile.upper() not in name.upper():
                continue

            href = f["href"]
            path, _, query = href.partition("?")
            url = base.BASE + urllib.parse.quote(path) + (f"?{query}" if query else "")
            version = re.search(r"Версия\s*(.+)$", f["text"].strip())

            candidates.append({
                "start": m.group(1),
                "end": m.group(2),
                "url": url,
                "file": name,
                "version": version.group(1).strip() if version else None,
                "_start_date": start,
                "_end_date": end,
                "_marked_current": bool(w.get("current")),
            })

    if not candidates:
        return []

    # Если сайт снова начнёт выставлять старую метку, используем её.
    marked = [x for x in candidates if x["_marked_current"]]
    if marked:
        selected = marked
    else:
        # Иначе определяем актуальные недели по датам. В воскресенье берём
        # следующую неделю, как это делает сам виджет; в остальные дни —
        # текущую и ближайшую следующую, если она уже опубликована.
        today = base.msk_now().date()
        if today.weekday() == 6:  # воскресенье
            ref = today + dt.timedelta(days=1)
        else:
            ref = today

        current = [x for x in candidates if x["_start_date"] <= ref <= x["_end_date"]]
        future = sorted(
            [x for x in candidates if x["_start_date"] > ref],
            key=lambda x: x["_start_date"],
        )

        selected = current[:1]
        if future:
            selected.append(future[0])

        # На случай каникул/разрыва публикаций — ближайшая не прошедшая неделя.
        if not selected:
            selected = sorted(
                [x for x in candidates if x["_end_date"] >= ref],
                key=lambda x: x["_start_date"],
            )[:1]

    out = []
    for x in selected:
        x = dict(x)
        x.pop("_start_date", None)
        x.pop("_end_date", None)
        x.pop("_marked_current", None)
        out.append(x)
    return out


base.find_week_pdfs = find_week_pdfs

if __name__ == "__main__":
    raise SystemExit(base.main())
