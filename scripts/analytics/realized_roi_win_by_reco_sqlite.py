#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Compute realized WIN ROI for recommendations on given dates using EveryDB2 (SQLite).

Inputs:
  - EDB_PATH env var: path to EveryDB2 SQLite database
  - Dates via CLI: YYYY-MM-DD (space-separated)

Reads reco from data/days/reco-YYYY-MM-DD.json and evaluates WIN picks.
Stake: 100 per WIN pick. Return: odds*100 if KakuteiJyuni == 1, else 0.
Odds source: N_UMA_RACE.Odds (10x) fallback S_ODDS_TANPUKU.TanOdds (10x).
"""

import json
import os
import sqlite3
from typing import Dict, Tuple, List

NAME_TO_JYO = {
    "札幌": "01", "函館": "02", "福島": "03", "新潟": "04", "東京": "05",
    "中山": "06", "中京": "07", "京都": "08", "阪神": "09", "小倉": "10",
}


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


def read_reco(date_iso: str):
    p = os.path.join('data', 'days', f'reco-{date_iso}.json')
    if not os.path.exists(p):
        # fallback to public if needed
        p2 = os.path.join('public', 'data', f'reco-{date_iso}.json')
        if os.path.exists(p2):
            p = p2
        else:
            raise FileNotFoundError(p)
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def main():
    edb = os.environ.get('EDB_PATH') or os.environ.get('SQLITE_DB') or os.environ.get('EDB')
    if not edb or not os.path.exists(edb):
        raise SystemExit('EDB_PATH not set or file not found')
    import sys
    dates = [d for d in sys.argv[1:] if d and len(d) == 10]
    if not dates:
        raise SystemExit('Usage: realized_roi_win_by_reco_sqlite.py YYYY-MM-DD [YYYY-MM-DD ...]')

    con = sqlite3.connect(edb)
    cur = con.cursor()

    print('date,stake,ret,roi')
    total_stake = 0
    total_ret = 0.0
    for date_iso in dates:
        try:
            reco = read_reco(date_iso)
        except FileNotFoundError:
            print(f'{date_iso},0,0,0.000')
            continue
        y = date_iso[0:4]
        mm = date_iso[5:7]
        dd = date_iso[8:10]
        ymd_num = int(y) * 10000 + int(mm + dd)

        stake = 0
        ret = 0.0

        for r in reco.get('races', []):
            track = str(r.get('track', '')).strip()
            jyo = NAME_TO_JYO.get(track)
            if not jyo:
                continue
            no = to_int_or_none(r.get('no')) or 0
            win_list = r.get('win') or []
            if not isinstance(win_list, list):
                continue
            for umaban in win_list:
                stake += 100
                # fetch finish and odds
                cur.execute(
                    """
                    SELECT um.KakuteiJyuni, um.Odds, so.TanOdds
                    FROM N_UMA_RACE AS um
                    LEFT JOIN S_ODDS_TANPUKU AS so
                      ON um.Year = so.Year AND um.MonthDay = so.MonthDay
                     AND um.JyoCD = so.JyoCD AND um.RaceNum = so.RaceNum AND um.Umaban = so.Umaban
                    WHERE CAST(um.Year AS INTEGER) = ? AND CAST(um.MonthDay AS INTEGER) = ?
                      AND um.JyoCD = ? AND CAST(um.RaceNum AS INTEGER) = ? AND CAST(um.Umaban AS INTEGER) = ?
                      AND um.DataKubun IN ('5','7')
                    LIMIT 1
                    """,
                    (int(y), int(mm + dd), jyo, int(no), int(umaban)),
                )
                row = cur.fetchone()
                if not row:
                    continue
                fin = to_int_or_none(row[0])
                odds = to_odds_decimal(row[1], row[2])
                if fin == 1 and odds is not None:
                    ret += odds * 100.0

        total_stake += stake
        total_ret += ret
        roi = (ret / stake) if stake > 0 else 0.0
        print(f"{date_iso},{stake},{int(ret)},{roi:.3f}")

    total_roi = (total_ret / total_stake) if total_stake > 0 else 0.0
    print(f"TOTAL,{total_stake},{int(total_ret)},{total_roi:.3f}")


if __name__ == '__main__':
    main()


