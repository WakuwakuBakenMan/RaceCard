-- 中山(06)・阪神(09) それぞれのレース番号の抜けチェック
WITH ra AS (
  SELECT
    CAST(NULLIF(TRIM(kaisai_nen), '') AS INTEGER) AS year,
    CAST(NULLIF(TRIM(kaisai_tsukihi), '') AS INTEGER) AS mmdd,
    LPAD(TRIM(keibajo_code), 2, '0') AS jyo,
    CAST(NULLIF(TRIM(race_bango), '') AS INTEGER) AS rn
  FROM public.jvd_ra
  WHERE CAST(NULLIF(TRIM(kaisai_nen), '') AS INTEGER) = 2025
    AND CAST(NULLIF(TRIM(kaisai_tsukihi), '') AS INTEGER) = 921
)
SELECT jyo,
       COUNT(*) AS race_rows,
       MIN(rn)  AS min_r,
       MAX(rn)  AS max_r,
       ARRAY_AGG(rn ORDER BY rn) AS rn_list
FROM ra
WHERE jyo IN ('06','09')
GROUP BY jyo
ORDER BY jyo;