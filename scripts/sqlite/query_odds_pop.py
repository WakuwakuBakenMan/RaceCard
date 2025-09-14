#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
EveryDB2(SQLite) から単レースの 馬番ごとのオッズ/人気 を取得して JSON で出力します。

入力キー: Year, MonthDay, JyoCD, Kaiji, Nichiji, RaceNum

優先順位:
- N_UMA_RACE.Odds / Ninki（10倍表現）
- 欠損や0のときは S_ODDS_TANPUKU.TanOdds / TanNinki（こちらも10倍表現）

使用例:
  python3 scripts/sqlite/query_odds_pop.py \
    --db /path/to/everydb.sqlite \
    --year 2025 --mmdd 0915 --jyo 06 --kaiji 4 --nichiji 5 --race 12
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from typing import Dict


def to_int_or_none(v):
    if v is None:
        return None
    s = str(v).strip()
    if s == "" or s.upper() == "NULL":
        return None
    try:
        return int(float(s))
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--year", required=True)
    ap.add_argument("--mmdd", required=True)
    ap.add_argument("--jyo", required=True)
    ap.add_argument("--kaiji", required=True)
    ap.add_argument("--nichiji", required=True)
    ap.add_argument("--race", required=True)
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    cur = conn.cursor()

    sql = (
        """
        SELECT um.Umaban,
               CASE WHEN um.Odds IS NULL OR CAST(um.Odds AS INTEGER) = 0 THEN so.TanOdds ELSE um.Odds END AS Odds,
               CASE WHEN um.Ninki IS NULL OR CAST(um.Ninki AS INTEGER) = 0 THEN so.TanNinki ELSE um.Ninki END AS Ninki
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
        """
    )
    cur.execute(sql, (args.year, args.mmdd, args.jyo, args.kaiji, args.nichiji, args.race))
    out: Dict[str, Dict[str, int]] = {}
    for umaban, odds, ninki in cur.fetchall():
        num = str(to_int_or_none(umaban) or 0)
        o = to_int_or_none(odds)
        n = to_int_or_none(ninki)
        if num == '0':
            continue
        ent: Dict[str, int | float] = {}
        if o is not None and o > 0:
            ent["odds"] = round(o / 10.0, 1)
        if n is not None and n > 0:
            ent["popularity"] = n
        if ent:
            out[num] = ent  # type: ignore

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()

