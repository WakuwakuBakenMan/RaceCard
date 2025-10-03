#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Compute realized ROI for WIN/PLACE/UMAREN (馬連) based on recommendations and EveryDB2 payouts (SQLite N_HARAI).

Inputs:
  - EDB_PATH env var: path to EveryDB2 SQLite DB
  - Dates via CLI: YYYY-MM-DD (space-separated)

Reco source: data/days/reco-YYYY-MM-DD.json or public/data/reco-YYYY-MM-DD.json
Stake per pick: 100
WIN return: odds * 100 if finish=1 (fallback via N_UMA_RACE/S_ODDS_TANPUKU similar to prior script)
PLACE return: payout from N_HARAI (fukusho)
UMAREN return: payout from N_HARAI (umaren) for each pair in quinella_box
"""

import json
import os
import sqlite3
import re
from typing import Dict, Tuple, List, Any

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


def digits_int(v: Any) -> int | None:
    s = str(v or '').strip()
    if not s:
        return None
    ds = re.sub(r"\D", "", s)
    if not ds:
        return None
    try:
        return int(ds)
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
        p2 = os.path.join('public', 'data', f'reco-{date_iso}.json')
        if os.path.exists(p2):
            p = p2
        else:
            raise FileNotFoundError(p)
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def normalize_umaren_code(raw: Any) -> str | None:
    s = str(raw or '').strip()
    if not s:
        return None
    # pattern: 1-2, 01=02, 1 / 2
    import re
    m = re.search(r"(\d{1,2})\D+(\d{1,2})", s)
    if m:
        a = int(m.group(1)); b = int(m.group(2))
        if a>0 and b>0:
            x,y = sorted([a,b])
            return f"{x:02d}{y:02d}"
    # 4 digits: 0102, 1203
    digits = re.sub(r"\D", "", s)
    if len(digits) == 4:
        a = int(digits[:2]); b = int(digits[2:])
        if a>0 and b>0:
            x,y = sorted([a,b])
            return f"{x:02d}{y:02d}"
    # 3 digits: 112 -> 1 and 12
    if len(digits) == 3:
        a = int(digits[:1]); b = int(digits[1:])
        if a>0 and b>0:
            x,y = sorted([a,b])
            return f"{x:02d}{y:02d}"
    return None


def main():
    edb = os.environ.get('EDB_PATH') or os.environ.get('SQLITE_DB') or os.environ.get('EDB')
    if not edb or not os.path.exists(edb):
        raise SystemExit('EDB_PATH not set or file not found')
    import sys
    dates = [d for d in sys.argv[1:] if d and len(d) == 10]
    if not dates:
        raise SystemExit('Usage: realized_roi_all_by_reco_sqlite.py YYYY-MM-DD [YYYY-MM-DD ...]')

    con = sqlite3.connect(edb)
    cur = con.cursor()

    # Preload N_HARAI column names
    cur.execute("PRAGMA table_info(N_HARAI)")
    cols = [r[1] for r in cur.fetchall()]
    # Column naming (EveryDB2):
    #  - 複勝: PayFukusyoUmaban{n} / PayFukusyoPay{n} (n=1..5)
    #  - 馬連: PayUmarenKumi{n} / PayUmarenPay{n}   (n=1..3)
    import re
    def numbered_pairs(prefix_key: str, prefix_pay: str, max_n: int) -> List[tuple[str,str]]:
        pairs: List[tuple[str,str]] = []
        for n in range(1, max_n+1):
            a = f"{prefix_key}{n}"
            b = f"{prefix_pay}{n}"
            if a in cols and b in cols:
                pairs.append((a,b))
        return pairs
    fuku_pairs = numbered_pairs('PayFukusyoUmaban', 'PayFukusyoPay', 5)
    uma_pairs = numbered_pairs('PayUmarenKumi', 'PayUmarenPay', 3)

    print('date,market,stake,ret,roi')
    total = { 'win': {'stake':0,'ret':0.0}, 'place': {'stake':0,'ret':0.0}, 'umaren': {'stake':0,'ret':0.0} }

    for date_iso in dates:
        reco = read_reco(date_iso)
        y = int(date_iso[:4])
        mm = int(date_iso[5:7])
        dd = int(date_iso[8:10])
        y_str = f"{y:04d}"
        md_str = f"{mm:02d}{dd:02d}"

        sums = { 'win': {'stake':0,'ret':0.0}, 'place': {'stake':0,'ret':0.0}, 'umaren': {'stake':0,'ret':0.0} }

        for r in reco.get('races', []):
            track = str(r.get('track','')).strip()
            jyo = NAME_TO_JYO.get(track)
            if not jyo:
                continue
            no = to_int_or_none(r.get('no')) or 0
            # load payout row
            cur.execute(
                "SELECT * FROM N_HARAI WHERE Year=? AND MonthDay=? AND JyoCD=? AND RaceNum=? LIMIT 1",
                (y_str, md_str, str(jyo).zfill(2), f"{int(no):02d}")
            )
            row = cur.fetchone()
            desc = [d[0] for d in cur.description] if cur.description else []
            row_map = { desc[i]: row[i] for i in range(len(desc)) } if row else {}

            # WIN: use odds-based return (as earlier)
            for umaban in (r.get('win') or []):
                sums['win']['stake'] += 100
                # finish+odds
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
                    (y, int(f"{mm:02d}{dd:02d}"), jyo, int(no), int(umaban)),
                )
                rw = cur.fetchone()
                if rw:
                    fin = to_int_or_none(rw[0])
                    odds = to_odds_decimal(rw[1], rw[2])
                    if fin == 1 and odds is not None:
                        sums['win']['ret'] += odds * 100.0

            # PLACE: stake from reco picks, ret from N_HARAI when available
            pl = r.get('place') or []
            # stake increments regardless of payout availability
            for _ in pl:
                sums['place']['stake'] += 100
            if row_map and pl:
                # build map horse->payout from fukusho pairs
                fuku_pay_map: Dict[int,int] = {}
                for a,b in fuku_pairs:
                    ua = row_map.get(a)
                    pb = row_map.get(b)
                    u = digits_int(ua)
                    p = digits_int(pb)
                    if u and p:
                        fuku_pay_map[u] = p
                for umaban in pl:
                    p = fuku_pay_map.get(int(umaban))
                    if p:
                        sums['place']['ret'] += float(p)

            # UMAREN: box pairs to payout mapping
            box = r.get('quinella_box') or []
            if isinstance(box, list) and len(box) >= 2:
                import itertools
                pairs = list(itertools.combinations([int(x) for x in box], 2))
                # stake increments for all pairs
                sums['umaren']['stake'] += 100 * len(pairs)
                if row_map:
                    # payout codes map
                    uma_pay_map: Dict[str,int] = {}
                for a,b in uma_pairs:
                    ra = row_map.get(a)
                    rb = row_map.get(b)
                    code = normalize_umaren_code(ra)
                    pay = digits_int(rb)
                    if code and pay:
                        uma_pay_map[code] = pay
                    # add returns for hit pairs
                    for a,b in pairs:
                        x,y = sorted([a,b])
                        code = f"{x:02d}{y:02d}"
                        pay = uma_pay_map.get(code)
                        if pay:
                            sums['umaren']['ret'] += float(pay)

        for mk in ['win','place','umaren']:
            total[mk]['stake'] += sums[mk]['stake']
            total[mk]['ret'] += sums[mk]['ret']
            roi = (sums[mk]['ret']/sums[mk]['stake']) if sums[mk]['stake']>0 else 0.0
            print(f"{date_iso},{mk},{sums[mk]['stake']},{int(sums[mk]['ret'])},{roi:.3f}")

    # totals
    for mk in ['win','place','umaren']:
        roi = (total[mk]['ret']/total[mk]['stake']) if total[mk]['stake']>0 else 0.0
        print(f"TOTAL,{mk},{total[mk]['stake']},{int(total[mk]['ret'])},{roi:.3f}")


if __name__ == '__main__':
    main()


