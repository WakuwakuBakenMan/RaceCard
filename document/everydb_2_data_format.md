# EveryDB2 データフォーマット整理ドキュメント

## 全体像
- **テーブル群は2系統**  
  - `N_****`: 蓄積系（通常/今週/セットアップで更新）。過去から最新まで参照可能。  
  - `S_****`: 速報系（今週＋速報のみ、15日超は自動削除）。最新速報だけ参照したい用途向け。

- **キー設計（レースを一意に表す）**  
  `Year, MonthDay, JyoCD, Kaiji, Nichiji, RaceNum` がレース主キー。  
  馬単位のデータでは `Umaban` を追加。  

- **確定データの扱い（DataKubun）**  
  - `5` = 速報全馬確定  
  - `7` = 月曜確定  
  → 通常は `DataKubun IN ('5','7')` で確定データに絞る。

- **コード表**  
  競馬場コード（01=札幌, 02=函館, …, 10=小倉）など公式ページに定義あり。

---

## 主要テーブル

### N_RACE
- レース詳細（番組・条件・距離・コースなど）
- レース主キーを持つ

### N_UMA_RACE
- 出走馬ごとの成績・属性
- 主なカラム:
  - `KettoNum` (血統登録番号)
  - `Bamei` (馬名)
  - `SexCD` (性別コード)
  - `Barei` (馬齢)
  - `ChokyosiCode` (調教師コード)
  - `KisyuCode` (騎手コード)
  - `Odds`, `Ninki`
  - `KakuteiJyuni` (確定着順)
  - `Jyuni1c`～`Jyuni4c` (コーナー通過順位)

### N_HR
- 払戻情報
- レース主キーで結合

### N_UMA
- 馬マスタ（血統・生産者など）
- `KettoNum` で結合

### N_RECORD
- レコード情報（コース/G1レコード）

### N_SCHEDULE
- 開催スケジュール

---

## インデックス設計
```sql
CREATE INDEX IF NOT EXISTS idx_race_key
ON N_RACE (Year, MonthDay, JyoCD, Kaiji, Nichiji, RaceNum);

CREATE INDEX IF NOT EXISTS idx_uma_race_key
ON N_UMA_RACE (Year, MonthDay, JyoCD, Kaiji, Nichiji, RaceNum, Umaban);

CREATE INDEX IF NOT EXISTS idx_uma_ketto
ON N_UMA_RACE (KettoNum);
```

---

## サンプルSQL

### レース×馬結合の基本
```sql
WITH base AS (
  SELECT
    r.Year, r.MonthDay, r.JyoCD, r.Kaiji, r.Nichiji, r.RaceNum,
    u.Umaban, u.KettoNum, u.Bamei,
    CAST(u.KakuteiJyuni AS INTEGER) AS fin_pos,
    CAST(u.Ninki AS INTEGER) AS pop,
    CAST(u.Odds AS REAL) AS odds
  FROM N_RACE r
  JOIN N_UMA_RACE u
    ON r.Year=u.Year AND r.MonthDay=u.MonthDay
   AND r.JyoCD=u.JyoCD AND r.Kaiji=u.Kaiji
   AND r.Nichiji=u.Nichiji AND r.RaceNum=u.RaceNum
  WHERE u.DataKubun IN ('5','7')
)
SELECT * FROM base
LIMIT 50;
```

### 人気別の勝率・連対率・複勝率
```sql
WITH t AS (
  SELECT
    CAST(u.Ninki AS INTEGER) AS pop,
    CAST(u.KakuteiJyuni AS INTEGER) AS fin
  FROM N_UMA_RACE u
  WHERE u.DataKubun IN ('5','7')
    AND u.Ninki <> '' AND u.KakuteiJyuni <> ''
)
SELECT
  pop,
  ROUND(AVG(CASE WHEN fin = 1 THEN 1.0 ELSE 0 END)*100,2) AS 勝率_pct,
  ROUND(AVG(CASE WHEN fin <=2 THEN 1.0 ELSE 0 END)*100,2) AS 連対率_pct,
  ROUND(AVG(CASE WHEN fin <=3 THEN 1.0 ELSE 0 END)*100,2) AS 複勝率_pct,
  COUNT(*) AS 出走頭数
FROM t
GROUP BY pop
ORDER BY pop;
```

### 逃げ馬の成績（通過順）
```sql
WITH t AS (
  SELECT
    CAST(NULLIF(u.Jyuni1c,'') AS INTEGER) AS c1,
    CAST(NULLIF(u.Jyuni2c,'') AS INTEGER) AS c2,
    CAST(NULLIF(u.Jyuni3c,'') AS INTEGER) AS c3,
    CAST(NULLIF(u.Jyuni4c,'') AS INTEGER) AS c4,
    CAST(NULLIF(u.KakuteiJyuni,'') AS INTEGER) AS fin
  FROM N_UMA_RACE u
  WHERE u.DataKubun IN ('5','7')
),
flags AS (
  SELECT
    fin,
    CASE WHEN COALESCE(c1, c2, c3, c4) = 1 THEN 1 ELSE 0 END AS is_nige
  FROM t
  WHERE fin IS NOT NULL
)
SELECT
  ROUND(AVG(CASE WHEN fin = 1 THEN 1.0 ELSE 0 END)*100,2) AS 勝率_pct,
  ROUND(AVG(CASE WHEN fin <= 2 THEN 1.0 ELSE 0 END)*100,2) AS 連対率_pct,
  ROUND(AVG(CASE WHEN fin <= 3 THEN 1.0 ELSE 0 END)*100,2) AS 複勝率_pct,
  COUNT(*) AS 頭数
FROM flags WHERE is_nige=1;
```

---

## 運用上の注意
- インデックスは一度作れば自動維持される。新規DBを作った場合のみ再作成が必要。
- 多くの列は文字列型なので、数値集計時は `CAST` を使う。
- 直線コースなどでは `Jyuni1c` が NULL になる場合があるので `COALESCE` で処理する。



## 全カラム一覧
### N_RACE（110列）
- RecordSpec
- DataKubun
- MakeDate
- Year
- MonthDay
- JyoCD
- Kaiji
- Nichiji
- RaceNum
- YoubiCD
- TokuNum
- Hondai
- Fukudai
- Kakko
- HondaiEng
- FukudaiEng
- KakkoEng
- Ryakusyo10
- Ryakusyo6
- Ryakusyo3
- Kubun
- GradeCD
- SyubetuCD
- KigoCD
- JyuryoCD
- JyokenCD1
- JyokenCD2
- JyokenCD3
- JyokenCD4
- JyokenCD5
- JyokenCD6
- JyokenCD7
- JyokenCD8
- JyokenCD9
- JyokenCD10
- Kyori
- KyoriTrackCD
- TrackCD
- CourseKubunCD
- Course
- TenkoCD
- BabaCD
- ShubetuCD
- KigoDisp
- JyuryouDisp
- JyokenNengappiDisp
- JyokenDisp
- KyoriTrackDisp
- CourseHyosu
- HassoTime
- TorokuTosu
- SyussoTosu
- NyusenTosu
- HassoTimeTsuika
- Hirubi
- TokubetsuKadaiCD
- TokubetsuRyakusyo
- KadoNum
- Hankyo
- KyoriTani
- CourseType
- CourseName
- BabaType
- BabaName
- CourseJyuni
- CourseID
- CourseNaiyou
- HassoBashoCD
- HassoBashoName
- HassoKyori
- HassoCourseKubunCD
- HassoTrackCD
- HassoKyoriTrackCD
- HassoCourse
- HassoCourseName
- HassoCourseID
- Ninki1YRPer
- Ninki2YRPer
- Ninki3YRPer
- Ninki4YRPer
- Ninki5YRPer
- KisyuCode1
- KisyuCode2
- KisyuCode3
- KisyuCode4
- KisyuCode5
- KisyuCode6
- KisyuCode7
- KisyuCode8
- KisyuCode9
- KisyuCode10
- Tenkai
- Corner1
- Syukaisu1
- Jyuni1
- Corner2
- Syukaisu2
- Jyuni2
- Corner3
- Syukaisu3
- Jyuni3
- Corner4
- Syukaisu4
- Jyuni4
- RecordUpKubun

### N_UMA_RACE（73列）
- RecordSpec
- DataKubun
- MakeDate
- Year
- MonthDay
- JyoCD
- Kaiji
- Nichiji
- RaceNum
- Umaban
- Wakuban
- KettoNum
- Bamei
- SexCD
- HinsyuCD
- KeiroCD
- Barei
- TozaiCD
- ChokyosiCode
- BanusouhanroCD1
- BanusouhanroCD2
- BanusouhanroCD3
- KisyuCode
- Futan
- FutanBefore
- Blinker
- Reserved2
- KisyuCodeBefore
- Odds
- Ninki
- KakuteiJyuni
- Time
- ChakusaCD
- Jyuni1c
- Jyuni2c
- Jyuni3c
- Jyuni4c
- TimeUpKubun
- Yoin1
- Yoin2
- Yoin3
- Kuse
- Ruiseki
- Hankei
- Jyutai
- KyoriCGaiKyou
- Kyuui
- Reserved1
- Reserved3
- Kyori
- TrackCD
- BabaCD
- HorseWeight
- HorseWeightZogen
- Ten
- Agari3F
- PaceUpKubun
- KishuKakuteiJyuni
- ChokyoKubun
- KyuShouCD
- KyuShouRiyuu
- TokubetsuKadaiCD
- DMKubun
- DMTime
- DMGosaP
- DMGosaM
- DMJyuni
- KyakusituKubun
- KettoNum2
- Bamei2
- KettoNum3
- Bamei3
- TimeDiff
- RecordUpKubun

### N_UMA（227列）
- RecordSpec
- DataKubun
- MakeDate
- KettoNum
- DelKubun
- Bamei
- BameiKana
- BameiEng
- KuroMokuKubun
- Kyusei
- SexCD
- HinsyuCD
- KeiroCD
- IchouKubun
- DenpaKubun
- UmarenNengetsu
- UmarenBasho
- BokujoCD
- BokujoMei
- ChichiKettoNum
- ChichiBamei
- HahaKettoNum
- HahaBamei
- ChichichiKettoNum
- ChichichiBamei
- ChichihahaKettoNum
- ChichihahaBamei
- HahachichiKettoNum
- HahachichiBamei
- HahahahaKettoNum
- HahahahaBamei
- TanpuKubun
- Tosu
- KinkyuKubun
- KyuushaCD
- KyuushaMei
- ZanKyuushaCD
- ZanKyuushaMei
- SeisanKuniCD
- SeisanKeito
- SanshutsuKubun
- Kigou
- MasuAge
- SeisouKubun
- SeisanBasho
- BreederMei
- ChokyosiCode
- ChokyosiMei
- DenryokuKubun
- DenryokuKubun2
- SeiriKubun
- ShinkiKaisaiKubun
- HozonKubun
- KyuushaZip
- KyuushaTodofuken
- KyuushaAddr
- KyuushaTel
- Kyori1
- Kyori2
- Kyori3
- Kyori4
- Kyori5
- Kyori6
- KyoriHyoka1
- KyoriHyoka2
- KyoriHyoka3
- KyoriHyoka4
- KyoriHyoka5
- KyoriHyoka6
- KyoriChakukaisu1
- KyoriChakukaisu2
- KyoriChakukaisu3
- KyoriChakukaisu4
- KyoriChakukaisu5
- KyoriChakukaisu6
- Kyori1Chakukaisu1
- Kyori1Chakukaisu2
- Kyori1Chakukaisu3
- Kyori1Chakukaisu4
- Kyori1Chakukaisu5
- Kyori1Chakukaisu6
- Kyori2Chakukaisu1
- Kyori2Chakukaisu2
- Kyori2Chakukaisu3
- Kyori2Chakukaisu4
- Kyori2Chakukaisu5
- Kyori2Chakukaisu6
- Kyori3Chakukaisu1
- Kyori3Chakukaisu2
- Kyori3Chakukaisu3
- Kyori3Chakukaisu4
- Kyori3Chakukaisu5
- Kyori3Chakukaisu6
- Kyori4Chakukaisu1
- Kyori4Chakukaisu2
- Kyori4Chakukaisu3
- Kyori4Chakukaisu4
- Kyori4Chakukaisu5
- Kyori4Chakukaisu6
- Kyori5Chakukaisu1
- Kyori5Chakukaisu2
- Kyori5Chakukaisu3
- Kyori5Chakukaisu4
- Kyori5Chakukaisu5
- Kyori5Chakukaisu6
- Kyori6Chakukaisu1
- Kyori6Chakukaisu2
- Kyori6Chakukaisu3
- Kyori6Chakukaisu4
- Kyori6Chakukaisu5
- Kyori6Chakukaisu6
- Kyori1Chakusa1
- Kyori1Chakusa2
- Kyori1Chakusa3
- Kyori1Chakusa4
- Kyori1Chakusa5
- Kyori1Chakusa6
- Kyori2Chakusa1
- Kyori2Chakusa2
- Kyori2Chakusa3
- Kyori2Chakusa4
- Kyori2Chakusa5
- Kyori2Chakusa6
- Kyori3Chakusa1
- Kyori3Chakusa2
- Kyori3Chakusa3
- Kyori3Chakusa4
- Kyori3Chakusa5
- Kyori3Chakusa6
- Kyori4Chakusa1
- Kyori4Chakusa2
- Kyori4Chakusa3
- Kyori4Chakusa4
- Kyori4Chakusa5
- Kyori4Chakusa6
- Kyori5Chakusa1
- Kyori5Chakusa2
- Kyori5Chakusa3
- Kyori5Chakusa4
- Kyori5Chakusa5
- Kyori5Chakusa6
- Kyori6Chakusa1
- Kyori6Chakusa2
- Kyori6Chakusa3
- Kyori6Chakusa4
- Kyori6Chakusa5
- Kyori6Chakusa6
- Kyori1Time1
- Kyori1Time2
- Kyori1Time3
- Kyori1Time4
- Kyori1Time5
- Kyori1Time6
- Kyori2Time1
- Kyori2Time2
- Kyori2Time3
- Kyori2Time4
- Kyori2Time5
- Kyori2Time6
- Kyori3Time1
- Kyori3Time2
- Kyori3Time3
- Kyori3Time4
- Kyori3Time5
- Kyori3Time6
- Kyori4Time1
- Kyori4Time2
- Kyori4Time3
- Kyori4Time4
- Kyori4Time5
- Kyori4Time6
- Kyori5Time1
- Kyori5Time2
- Kyori5Time3
- Kyori5Time4
- Kyori5Time5
- Kyori5Time6
- Kyori6Time1
- Kyori6Time2
- Kyori6Time3
- Kyori6Time4
- Kyori6Time5
- Kyori6Time6
- Kyori1Tameri1
- Kyori1Tameri2
- Kyori1Tameri3
- Kyori1Tameri4
- Kyori1Tameri5
- Kyori1Tameri6
- Kyori2Tameri1
- Kyori2Tameri2
- Kyori2Tameri3
- Kyori2Tameri4
- Kyori2Tameri5
- Kyori2Tameri6
- Kyori3Tameri1
- Kyori3Tameri2
- Kyori3Tameri3
- Kyori3Tameri4
- Kyori3Tameri5
- Kyori3Tameri6
- Kyori4Tameri1
- Kyori4Tameri2
- Kyori4Tameri3
- Kyori4Tameri4
- Kyori4Tameri5
- Kyori4Tameri6
- Kyori5Tameri1
- Kyori5Tameri2
- Kyori5Tameri3
- Kyori5Tameri4
- Kyori5Tameri5
- Kyori5Tameri6
- Kyori6Tameri1
- Kyori6Tameri2
- Kyori6Tameri3
- Kyori6Tameri4
- Kyori6Tameri5
- Kyori6Tameri6
- KachiumaTime
- Kachiuma3F
- KyoriHyoka
- KyoriChakukaisu
- KyoriChakusa
- KyoriTime
- KyoriTameri
- RaceCount
- Kyakusitu1
- Kyakusitu2
- Kyakusitu3
- Kyakusitu4

### N_HARAI（118列）
- RecordSpec
- DataKubun
- MakeDate
- Year
- MonthDay
- JyoCD
- Kaiji
- Nichiji
- RaceNum
- HaraiType
- HaraiNum
- Kumi1
- Kumi2
- Kumi3
- Kumi4
- Kumi5
- Kumi6
- Kumi7
- Kumi8
- Kumi9
- Kumi10
- Kumi11
- Kumi12
- Pay
- Ninki
- Haraikubun
- TanshoUmaban
- TanshoPay
- TanshoNinki
- FukushoUmaban1
- FukushoPay1
- FukushoNinki1
- FukushoUmaban2
- FukushoPay2
- FukushoNinki2
- FukushoUmaban3
- FukushoPay3
- FukushoNinki3
- WakurenUmaban
- WakurenPay
- WakurenNinki
- UmarenUmaban
- UmarenPay
- UmarenNinki
- WideUmaban1
- WidePay1
- WideNinki1
- WideUmaban2
- WidePay2
- WideNinki2
- WideUmaban3
- WidePay3
- WideNinki3
- WideUmaban4
- WidePay4
- WideNinki4
- WideUmaban5
- WidePay5
- WideNinki5
- WideUmaban6
- WidePay6
- WideNinki6
- SanrenpukuUmaban
- SanrenpukuPay
- SanrenpukuNinki
- UmatanUmaban
- UmatanPay
- UmatanNinki
- SanrentanUmaban
- SanrentanPay
- SanrentanNinki

