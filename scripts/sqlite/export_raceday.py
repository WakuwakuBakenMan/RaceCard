#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
SQLite → RaceDay(JSON) エクスポート

前提:
- DBはEveryDB2系(テーブル: N_RACE, N_UMA_RACE, N_KISYU, N_CHOKYO 等)
- 確定データのみ(DataKubun IN ('5','7'))を対象

出力:
- data/days/YYYY-MM-DD.json (RaceDayスキーマ)
- --publish-latest 指定時: public/data/date1..4.json に最新4件を配置

使用例:
  python3 scripts/sqlite/export_raceday.py --db path/to/everydb2.sqlite --latest 4 --publish-latest
  python3 scripts/sqlite/export_raceday.py --db path/to/everydb2.sqlite --date 20240914 --date 20240915
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Tuple


# --- Static mappings (最小限) ---
JYOCD_TO_TRACK = {
    "01": "札幌",
    "02": "函館",
    "03": "福島",
    "04": "新潟",
    "05": "東京",
    "06": "中山",
    "07": "中京",
    "08": "京都",
    "09": "阪神",
    "10": "小倉",
}

def ground_from_trackcd(trackcd: Optional[str]) -> str:
    s = str(trackcd) if trackcd is not None else ""
    if not s:
        return ""
    head = s[0]
    if head == "1":
        return "芝"
    if head == "2":
        return "ダ"
    if head == "5":
        return "障"
    return ""

SEXCD_TO_JA = {
    "1": "牡",
    "2": "牝",
    "3": "セ",
}

BABACD_TO_COND = {
    "1": "良",
    "2": "稍重",
    "3": "重",
    "4": "不良",
}


def to_int_or_none(v: Optional[str]) -> Optional[int]:
    if v is None:
        return None
    s = str(v).strip()
    if s == "" or s.upper() == "NULL":
        return None
    try:
        return int(float(s))
    except Exception:
        return None


def to_float_or_none(v: Optional[str]) -> Optional[float]:
    if v is None:
        return None
    s = str(v).strip()
    if s == "" or s.upper() == "NULL":
        return None
    try:
        return float(s)
    except Exception:
        return None


def hhmm_to_time(v: Optional[str]) -> Optional[str]:
    if not v:
        return None
    s = str(v).strip()
    if len(s) == 4 and s.isdigit():
        return f"{s[:2]}:{s[2:]}"
    return None


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def query_single_text_map(cur: sqlite3.Cursor, table: str, code_col: str, name_candidates: List[str]) -> Dict[str, str]:
    # テーブル存在確認＆定義から最適な名称列を推測
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
    row = cur.fetchone()
    if not row:
        return {}
    cur.execute(f"PRAGMA table_info({table})")
    cols = [r[1] for r in cur.fetchall()]
    name_col = None
    for cand in name_candidates:
        if cand in cols:
            name_col = cand
            break
    if not name_col:
        # 最後のfallback: コード以外の最初のTEXT列を名称扱い
        name_col = next((c for c in cols if c != code_col), None)
    if not name_col:
        return {}
    cur.execute(f"SELECT {code_col}, {name_col} FROM {table}")
    m: Dict[str, str] = {}
    for code, name in cur.fetchall():
        if code is None:
            continue
        m[str(code)] = str(name) if name is not None else ""
    return m


@dataclass
class Horse:
    num: int
    draw: int
    name: str
    sex: str
    age: int
    weight: int
    jockey: str
    trainer: str
    odds: Optional[float] = None
    popularity: Optional[int] = None
    pace_type: Optional[List[str]] = None


@dataclass
class Race:
    no: int
    name: str
    distance_m: int
    ground: str
    course_note: Optional[str] = None
    condition: Optional[str] = None
    start_time: Optional[str] = None
    pace_score: Optional[int] = None
    pace_mark: Optional[str] = None
    horses: List[Horse] = None


@dataclass
class Meeting:
    track: str
    kaiji: int
    nichiji: int
    races: List[Race]


@dataclass
class RaceDay:
    date: str
    meetings: List[Meeting]


def get_available_dates(cur: sqlite3.Cursor) -> List[str]:
    cur.execute(
        """
        SELECT DISTINCT printf('%04d%04d', CAST(Year AS INTEGER), CAST(MonthDay AS INTEGER)) AS ymd
        FROM N_RACE
        WHERE Year <> '' AND MonthDay <> ''
        ORDER BY ymd
        """
    )
    return [r[0] for r in cur.fetchall() if r[0]]


def build_raceday(cur: sqlite3.Cursor, ymd: str) -> RaceDay:
    yyyy = ymd[:4]
    mmdd = ymd[4:]
    date_iso = f"{yyyy}-{mmdd[:2]}-{mmdd[2:]}"

    # 騎手/調教師のコード→氏名
    kisyu_map = query_single_text_map(cur, "N_KISYU", "KisyuCode", ["KisyuName", "KisyuRyakusyo", "KisyuNameKana"])
    chokyo_map = query_single_text_map(cur, "N_CHOKYO", "ChokyosiCode", ["ChokyosiName", "ChokyosiRyakusyo", "ChokyosiNameKana"])

    # レース一覧
    cur.execute(
        """
        SELECT
          Year, MonthDay, JyoCD, Kaiji, Nichiji, RaceNum,
          Hondai, Kyori, TrackCD, SibaBabaCD, DirtBabaCD, HassoTime,
          KigoCD
        FROM N_RACE
        WHERE Year = ? AND MonthDay = ?
        ORDER BY JyoCD, Kaiji, Nichiji, CAST(RaceNum AS INTEGER)
        """,
        (yyyy, mmdd),
    )
    races = cur.fetchall()

    # meetingごとにまとめる
    meetings_dict: Dict[Tuple[str, int, int], List[Race]] = defaultdict(list)

    for r in races:
        (
            Year,
            MonthDay,
            JyoCD,
            Kaiji,
            Nichiji,
            RaceNum,
            Hondai,
            Kyori,
            TrackCD,
            SibaBabaCD,
            DirtBabaCD,
            HassoTime,
            KigoCD,
        ) = r

        key_cols = (Year, MonthDay, JyoCD, Kaiji, Nichiji, RaceNum)

        # 馬一覧（出走登録〜確定データ）
        cur.execute(
            """
            SELECT
              um.Umaban, um.Wakuban, um.Bamei, um.SexCD, um.Barei, um.Futan,
              um.KisyuCode, um.ChokyosiCode,
              CASE
                WHEN um.Odds IS NULL OR CAST(um.Odds AS INTEGER) = 0 THEN so.TanOdds
                ELSE um.Odds
              END AS Odds,
              CASE
                WHEN um.Ninki IS NULL OR CAST(um.Ninki AS INTEGER) = 0 THEN so.TanNinki
                ELSE um.Ninki
              END AS Ninki,
              um.Jyuni1c, um.Jyuni2c, um.Jyuni3c, um.Jyuni4c,
              um.KettoNum
            FROM N_UMA_RACE AS um
            LEFT JOIN S_ODDS_TANPUKU AS so
              ON um.Year = so.Year
              AND um.MonthDay = so.MonthDay
              AND um.JyoCD = so.JyoCD
              AND um.RaceNum = so.RaceNum
              AND um.Umaban = so.Umaban
            WHERE um.Year=? AND um.MonthDay=? AND um.JyoCD=? AND um.Kaiji=? AND um.Nichiji=? AND um.RaceNum=?
              AND um.DataKubun IN ('1','2','3','4','5','6','7')
            ORDER BY CAST(um.Umaban AS INTEGER)
            """,
            key_cols,
        )
        horses: List[Horse] = []
        a_headcount = 0
        b_headcount = 0
        c_headcount = 0
        for (
            Umaban,
            Wakuban,
            Bamei,
            SexCD,
            Barei,
            Futan,
            KisyuCode,
            ChokyosiCode,
            Odds,
            Ninki,
            Jyuni1c,
            Jyuni2c,
            Jyuni3c,
            Jyuni4c,
            KettoNum,
        ) in cur.fetchall():
            num = to_int_or_none(Umaban) or 0
            draw = to_int_or_none(Wakuban) or 0
            name = (Bamei or "").strip()
            sex = SEXCD_TO_JA.get(str(SexCD), str(SexCD) if SexCD is not None else "")
            age = to_int_or_none(Barei) or 0
            # 斤量: 10倍表現 → 1桁小数
            fut = to_int_or_none(Futan)
            weight = round((fut / 10.0), 1) if fut is not None else 0.0
            jockey = kisyu_map.get(str(KisyuCode), str(KisyuCode) if KisyuCode is not None else "")
            trainer = chokyo_map.get(str(ChokyosiCode), str(ChokyosiCode) if ChokyosiCode is not None else "")
            # オッズ: 10倍表現 → 実数
            o = to_int_or_none(Odds)
            odds = (o / 10.0) if o is not None else None
            pop = to_int_or_none(Ninki)

            # 展開タイプ（正式）: 直近3走の分類
            def to_cint(x):
                v = to_int_or_none(x)
                if v is None or v <= 0:
                    return None
                return v

            def classify_past(c1,c2,c3,c4):
                vals = [to_cint(c1), to_cint(c2), to_cint(c3), to_cint(c4)]
                pres = [v for v in vals if v is not None]
                if not pres:
                    return (False, False)  # (nige, senkou)
                first = pres[0]
                second = pres[1] if len(pres) >= 2 else None
                nige = (first == 1) or (first == 2 and second == 1)
                senkou = all(v <= 4 for v in pres)
                return (nige, senkou)

            # 直近3走をDBから取得
            pace_type: Optional[List[str]] = None
            nige_cnt = 0
            sen_cnt = 0
            if KettoNum:
                cur.execute(
                    """
                    SELECT Jyuni1c, Jyuni2c, Jyuni3c, Jyuni4c
                    FROM N_UMA_RACE
                    WHERE KettoNum=? AND DataKubun IN ('5','7')
                      AND CAST(Year AS INTEGER)*10000 + CAST(MonthDay AS INTEGER) < CAST(? AS INTEGER)
                    ORDER BY CAST(Year AS INTEGER) DESC, CAST(MonthDay AS INTEGER) DESC
                    LIMIT 20
                    """,
                    (KettoNum, f"{yyyy}{mmdd}"),
                )
                considered = 0
                for p in cur.fetchall():
                    vals = [to_cint(p[0]), to_cint(p[1]), to_cint(p[2]), to_cint(p[3])]
                    pres = [v for v in vals if v is not None]
                    if not pres:
                        # 全コーナー0/欠損のレースは近3走に含めない
                        continue
                    n, s = classify_past(p[0], p[1], p[2], p[3])
                    nige_cnt += 1 if n else 0
                    sen_cnt += 1 if s else 0
                    considered += 1
                    if considered >= 3:
                        break
            # 判定
            labels: List[str] = []
            if nige_cnt >= 2:
                labels.append("A")
            if sen_cnt >= 2:
                labels.append("B")
            elif sen_cnt >= 1:
                labels.append("C")
            pace_type = labels or None
            if pace_type:
                if "A" in pace_type:
                    a_headcount += 1
                if "B" in pace_type:
                    b_headcount += 1
                if "C" in pace_type:
                    c_headcount += 1
            if pace_type == ["A"]:
                a_headcount += 1

            horses.append(
                Horse(
                    num=num,
                    draw=draw,
                    name=name,
                    sex=sex,
                    age=age,
                    weight=weight,
                    jockey=jockey,
                    trainer=trainer,
                    odds=odds,
                    popularity=pop,
                    pace_type=pace_type,
                )
            )

        ground = ground_from_trackcd(TrackCD)
        # 馬場状態の選択（芝/ダで使い分け）
        cond_code = None
        sTC = str(TrackCD)
        if sTC.startswith("1"):
            cond_code = SibaBabaCD
        elif sTC.startswith("2"):
            cond_code = DirtBabaCD
        elif sTC.startswith("5"):
            # 障害は芝コンディションに準拠
            cond_code = SibaBabaCD

        # レースの展開カウント
        pace_score = None
        pace_mark = None
        if (a_headcount + b_headcount + c_headcount) == 0:
            pace_score = -3.5
            pace_mark = None
        else:
            score = 0.0
            score += b_headcount * 1.0
            score += c_headcount * 0.5
            if a_headcount == 0:
                score += -2.5
            if a_headcount >= 2:
                score += 1.5
            if b_headcount <= 2:
                score += -1.0
            pace_score = round(score, 1)
            pace_mark = "★" if pace_score <= 4.0 else None

        race = Race(
            no=to_int_or_none(RaceNum) or 0,
            name=((Hondai or "").strip() or None) or None,
            distance_m=to_int_or_none(Kyori) or 0,
            ground=ground,
            course_note=None,
            condition=BABACD_TO_COND.get(str(cond_code), None) if cond_code is not None else None,
            start_time=hhmm_to_time(HassoTime),
            pace_score=pace_score,
            pace_mark=pace_mark,
            horses=horses,
        )

        # レース名フォールバック: Hondaiが空なら 条件名を生成 → JyokenName → Ryakusyo10 → 距離/馬場
        if not race.name:
            # まずは条件から推測
            # 年齢帯: 出走馬の年齢から推測
            ages = [h.age for h in horses if isinstance(h.age, int) and h.age > 0]
            age_label = None
            if ages:
                if all(a == 2 for a in ages):
                    age_label = "2歳"
                else:
                    # 3歳以上（混在含む）
                    age_label = "3歳以上"

            # クラス種別: KigoCD の末尾・パターンで推測
            class_label = None
            kigo = (KigoCD or "").strip()
            if kigo:
                tail2 = kigo[-2:]
                if kigo.startswith("A0") or kigo.startswith("A"):
                    if tail2 == "03":
                        class_label = "1勝クラス"
                    elif tail2 == "04":
                        class_label = "2勝クラス"
                    elif tail2 == "05":
                        class_label = "3勝クラス"
                if class_label is None:
                    if tail2 == "01":
                        class_label = "新馬"
                    elif tail2 in ("02", "03", "23", "00") or kigo in ("000",):
                        class_label = "未勝利"
                    elif kigo.startswith("N") and tail2 == "04":
                        class_label = "オープン"

            if age_label and class_label:
                if ground == "障":
                    race.name = f"{age_label}障害{class_label}"
                else:
                    race.name = f"{age_label}{class_label}"

            # JyokenName を取りにいく（未決なら）
            cur.execute(
                """
                SELECT JyokenName, Ryakusyo10 FROM N_RACE
                WHERE Year=? AND MonthDay=? AND JyoCD=? AND Kaiji=? AND Nichiji=? AND RaceNum=?
                LIMIT 1
                """,
                key_cols,
            )
            row = cur.fetchone()
            if row:
                jname, ryaku = row
                if not race.name:
                    race.name = (jname or "").strip() or (ryaku or "").strip()
            if not race.name:
                # 例: 芝1500m / ダ1700m
                dist = to_int_or_none(Kyori) or 0
                race.name = f"{ground}{dist}m"

        meetings_dict[(str(JyoCD).zfill(2), to_int_or_none(Kaiji) or 0, to_int_or_none(Nichiji) or 0)].append(race)

    # Meeting配列に整形
    meetings: List[Meeting] = []
    for (jyo, kaiji, nichiji), race_list in meetings_dict.items():
        track = JYOCD_TO_TRACK.get(jyo, jyo)
        # レース番号順
        race_list.sort(key=lambda x: x.no)
        meetings.append(Meeting(track=track, kaiji=kaiji, nichiji=nichiji, races=race_list))

    # 開催順でソート: 競馬場→回→日→レース
    meetings.sort(key=lambda m: (m.track, m.kaiji, m.nichiji))

    return RaceDay(date=date_iso, meetings=meetings)


def write_raceday_json(rd: RaceDay, outdir: str) -> str:
    ensure_dir(outdir)
    path = os.path.join(outdir, f"{rd.date}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(
            {"date": rd.date, "meetings": [
                {
                    "track": m.track,
                    "kaiji": m.kaiji,
                    "nichiji": m.nichiji,
                    "races": [
                        {
                            "no": r.no,
                            "name": r.name,
                            "distance_m": r.distance_m,
                            "ground": r.ground,
                            **({"pace_score": r.pace_score} if r.pace_score is not None else {}),
                            **({"pace_mark": r.pace_mark} if r.pace_mark else {}),
                            **({"course_note": r.course_note} if r.course_note else {}),
                            **({"condition": r.condition} if r.condition else {}),
                            **({"start_time": r.start_time} if r.start_time else {}),
                            "horses": [
                                {
                                    "num": h.num,
                                    "draw": h.draw,
                                    "name": h.name,
                                    "sex": h.sex,
                                    "age": h.age,
                                    "weight": h.weight,
                                    "jockey": h.jockey,
                                    "trainer": h.trainer,
                                    **({"odds": h.odds} if h.odds is not None else {}),
                                    **({"popularity": h.popularity} if h.popularity is not None else {}),
                                    **({"pace_type": h.pace_type} if h.pace_type else {}),
                                }
                                for h in r.horses
                            ],
                        }
                        for r in m.races
                    ],
                }
                for m in rd.meetings
            ]},
            f,
            ensure_ascii=False,
            indent=2,
        )
    return path


def publish_latest(days_dir: str, public_dir: str, latest_n: int = 4) -> List[str]:
    ensure_dir(public_dir)
    # YYYY-MM-DD.json を日付でソート
    files = [f for f in os.listdir(days_dir) if f.endswith(".json")]
    files.sort()  # 文字列ソートで日付順
    selected = files[-latest_n:]
    if not selected:
        return []
    # 足りない場合は最古を左側に複製して埋める
    if len(selected) < latest_n:
        pad = [selected[0]] * (latest_n - len(selected))
        selected = pad + selected
    # date1(最古)→date4(最新)
    for idx, fname in enumerate(selected, start=1):
        src = os.path.join(days_dir, fname)
        dst = os.path.join(public_dir, f"date{idx}.json")
        with open(src, "r", encoding="utf-8") as rf, open(dst, "w", encoding="utf-8") as wf:
            wf.write(rf.read())
    return [os.path.join(public_dir, f"date{idx}.json") for idx in range(1, len(selected) + 1)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="SQLite DB file path")
    ap.add_argument("--date", action="append", help="対象日(YYYYMMDD)。複数指定可")
    ap.add_argument("--latest", type=int, help="DB内の最新N日を出力")
    ap.add_argument("--days-dir", default="data/days", help="日次JSON出力先")
    ap.add_argument(
        "--publish-latest",
        action="store_true",
        help="最新4件を public/data/date1..4.json に出力",
    )
    ap.add_argument("--public-data-dir", default="public/data", help="公開用ディレクトリ")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    cur = conn.cursor()

    targets: List[str] = []
    if args.date:
        targets = list(dict.fromkeys(args.date))  # unique
    else:
        all_ymd = get_available_dates(cur)
        if args.latest:
            targets = all_ymd[-args.latest :]
        else:
            if not all_ymd:
                raise SystemExit("No dates found in N_RACE")
            targets = [all_ymd[-1]]  # デフォルトは最新1日

    written: List[str] = []
    for ymd in targets:
        rd = build_raceday(cur, ymd)
        path = write_raceday_json(rd, args.days_dir)
        written.append(path)
        print(f"wrote: {path}")

    if args.publish_latest:
        outs = publish_latest(args.days_dir, args.public_data_dir, latest_n=4)
        for p in outs:
            print(f"published: {p}")


if __name__ == "__main__":
    main()
