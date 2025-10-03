#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Compute win ROI by odds bands split by horse pace type (A/B/C) from EveryDB2 (SQLite).

Type classification replicates the app's SQLite exporter logic:
  - For each horse (KettoNum), look back before the race date and read up to 20 prior races.
  - Consider up to the first 3 prior races with any valid corner positions.
  - Count:
      nige_cnt += 1 if first corner==1 OR (first==2 AND second==1)
      sen_cnt  += 1 if all corners present are <= 4
  - Labels:
      A if nige_cnt >= 2
      B if sen_cnt >= 2
      C if sen_cnt >= 1
      else None (skip)

Bands: <2, 2-5, 5-10, 10-25, >25
Stake: 100 per starter; Return: odds*100 if KakuteiJyuni == 1

Inputs:
  - EDB_PATH env var pointing to EveryDB2 SQLite DB
"""

import os
import sqlite3
from typing import Dict, Tuple


def to_int_or_none(v):
    try:
        s = str(v).strip()
        if s == '' or s.upper() == 'NULL':
            return None
        return int(float(s))
    except Exception:
        return None


def to_odds_decimal(odds10, fallback10):
    o = to_int_or_none(odds10)
    if o is not None and o > 0:
        return o / 10.0
    f = to_int_or_none(fallback10)
    if f is not None and f > 0:
        return f / 10.0
    return None


def band_of(od: float) -> str:
    if od < 2.0:
        return '<2'
    if od < 5.0:
        return '2-5'
    if od < 10.0:
        return '5-10'
    if od <= 25.0:
        return '10-25'
    return '>25'


def classify_pace_type_for_horse(cur: sqlite3.Cursor, ketto: str, target_num: int):
    # target_num: YYYYMMDD as integer, compare Year*10000 + MonthDay
    cur.execute(
        """
        SELECT Jyuni1c, Jyuni2c, Jyuni3c, Jyuni4c
        FROM N_UMA_RACE
        WHERE KettoNum = ? AND DataKubun IN ('5','7')
          AND (CAST(Year AS INTEGER)*10000 + CAST(MonthDay AS INTEGER)) < ?
        ORDER BY CAST(Year AS INTEGER) DESC, CAST(MonthDay AS INTEGER) DESC
        LIMIT 20
        """,
        (ketto, target_num),
    )
    nige_cnt = 0
    sen_cnt = 0
    considered = 0
    for row in cur.fetchall():
        c = [to_int_or_none(row[0]), to_int_or_none(row[1]), to_int_or_none(row[2]), to_int_or_none(row[3])]
        pres = [v for v in c if v is not None]
        if not pres:
            continue
        first = pres[0]
        second = pres[1] if len(pres) >= 2 else None
        nige = (first == 1) or (first == 2 and second == 1)
        senkou = all(v <= 4 for v in pres)
        if nige:
            nige_cnt += 1
        if senkou:
            sen_cnt += 1
        considered += 1
        if considered >= 3:
            break
    # decide
    if nige_cnt >= 2:
        return 'A'
    if sen_cnt >= 2:
        return 'B'
    if sen_cnt >= 1:
        return 'C'
    return None


def main():
    edb = os.environ.get('EDB_PATH') or os.environ.get('SQLITE_DB') or os.environ.get('EDB')
    if not edb or not os.path.exists(edb):
        raise SystemExit('EDB_PATH not set or file not found')

    con = sqlite3.connect(edb)
    cur = con.cursor()

    # main iterator: all starters with final data
    sql = """
      SELECT 
        um.Year, um.MonthDay, um.JyoCD, um.RaceNum,
        um.KettoNum,
        um.Odds AS Odds10, so.TanOdds AS TanOdds10,
        um.KakuteiJyuni
      FROM N_UMA_RACE AS um
      LEFT JOIN S_ODDS_TANPUKU AS so
        ON um.Year = so.Year AND um.MonthDay = so.MonthDay 
       AND um.JyoCD = so.JyoCD AND um.RaceNum = so.RaceNum AND um.Umaban = so.Umaban
      WHERE um.DataKubun IN ('5','7')
    """
    cur.execute(sql)

    # type -> band -> (stake, ret, starters, winners)
    agg: Dict[str, Dict[str, Tuple[int, float, int, int]]] = {}

    rows = cur.fetchall()
    for row in rows:
        year = str(row[0]).strip()
        mmdd = str(row[1]).strip()
        ketto = (str(row[4]).strip() if row[4] is not None else '')
        odds10 = row[5]
        tan10 = row[6]
        fin = to_int_or_none(row[7])
        if not year or not mmdd or not ketto:
            continue
        try:
            target_num = int(year) * 10000 + int(mmdd)
        except Exception:
            continue
        odds = to_odds_decimal(odds10, tan10)
        if odds is None:
            continue
        t = classify_pace_type_for_horse(cur, ketto, target_num)
        if t not in ('A','B','C'):
            continue
        band = band_of(odds)
        if t not in agg:
            agg[t] = {}
        stake, ret, starters, winners = agg[t].get(band, (0, 0.0, 0, 0))
        stake += 100
        starters += 1
        if fin == 1:
            ret += odds * 100.0
            winners += 1
        agg[t][band] = (stake, ret, starters, winners)

    # print CSV
    print('type,band,starters,winners,stake,ret,roi')
    order = ['<2', '2-5', '5-10', '10-25', '>25']
    for t in ['A','B','C']:
        bands = agg.get(t, {})
        for b in order:
            stake, ret, starters, winners = bands.get(b, (0, 0.0, 0, 0))
            roi = (ret / stake) if stake > 0 else 0.0
            print(f"{t},{b},{starters},{winners},{stake},{int(ret)},{roi:.3f}")


if __name__ == '__main__':
    main()


