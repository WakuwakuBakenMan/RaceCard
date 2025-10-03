#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Compute win ROI by odds bands from EveryDB2 (SQLite).

Inputs:
  - EDB_PATH env var pointing to EveryDB2 SQLite DB

Logic:
  - Use N_UMA_RACE (final data: DataKubun IN ('5','7'))
  - Odds = N_UMA_RACE.Odds (10x) fallback to S_ODDS_TANPUKU.TanOdds (10x)
  - Finish = KakuteiJyuni (1 = win)
  - Bands: <2, 2-5, 5-10, 10-25, >=25
  - Stake 100 per starter in band; Return = 100 * odds (decimal) if finish=1
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


def main():
    edb = os.environ.get('EDB_PATH') or os.environ.get('SQLITE_DB') or os.environ.get('EDB')
    if not edb or not os.path.exists(edb):
        raise SystemExit('EDB_PATH not set or file not found')

    con = sqlite3.connect(edb)
    cur = con.cursor()

    # Join N_UMA_RACE with S_ODDS_TANPUKU for fallback odds
    sql = """
      SELECT 
        um.Year, um.MonthDay, um.JyoCD, um.RaceNum,
        um.Odds AS Odds10, so.TanOdds AS TanOdds10,
        um.KakuteiJyuni
      FROM N_UMA_RACE AS um
      LEFT JOIN S_ODDS_TANPUKU AS so
        ON um.Year = so.Year AND um.MonthDay = so.MonthDay 
       AND um.JyoCD = so.JyoCD AND um.RaceNum = so.RaceNum AND um.Umaban = so.Umaban
      WHERE um.DataKubun IN ('5','7')
    """
    cur.execute(sql)

    # band accumulators: key -> (stake, ret, starters, winners)
    bands: Dict[str, Tuple[int, float, int, int]] = {}

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

    for row in cur.fetchall():
        Odds10 = to_int_or_none(row[4])
        TanOdds10 = to_int_or_none(row[5])
        fin = to_int_or_none(row[6])
        odds = None
        if Odds10 is not None and Odds10 > 0:
            odds = Odds10 / 10.0
        elif TanOdds10 is not None and TanOdds10 > 0:
            odds = TanOdds10 / 10.0
        if odds is None:
            continue
        b = band_of(odds)
        stake, ret, starters, winners = bands.get(b, (0, 0.0, 0, 0))
        stake += 100
        starters += 1
        if fin == 1:
            ret += odds * 100.0
            winners += 1
        bands[b] = (stake, ret, starters, winners)

    # print table sorted by intuitive order
    order = ['<2', '2-5', '5-10', '10-25', '>25']
    print('band,starters,winners,stake,ret,roi')
    for k in order:
        stake, ret, starters, winners = bands.get(k, (0, 0.0, 0, 0))
        roi = (ret / stake) if stake > 0 else 0.0
        print(f"{k},{starters},{winners},{stake},{int(ret)},{roi:.3f}")


if __name__ == '__main__':
    main()


