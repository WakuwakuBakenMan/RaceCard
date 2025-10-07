-- Usage:
--   psql "$PG_DSN" -v ketto=2022110105 -v target=20251005 -f scripts/pg/check_passages.sql
-- Vars:
--   :ketto  ... ketto_toroku_bango (text or numeric)
--   :target ... yyyymmdd as integer (e.g., 20251005)

WITH se_all AS (
  SELECT 'J' AS src,
         se.ketto_toroku_bango::text AS ketto_toroku_bango,
         se.kaisai_nen, se.kaisai_tsukihi, se.race_bango,
         se.corner_1, se.corner_2, se.corner_3, se.corner_4
  FROM public.jvd_se se
  WHERE se.ketto_toroku_bango::text = :'ketto'
    AND (CAST(se.kaisai_nen AS INTEGER)*10000 + CAST(se.kaisai_tsukihi AS INTEGER)) < :'target'
    AND COALESCE(NULLIF(TRIM(se.data_kubun), ''), '') IN ('6','7')
    AND (
      NULLIF(TRIM(se.corner_1), '') IS NOT NULL OR
      NULLIF(TRIM(se.corner_2), '') IS NOT NULL OR
      NULLIF(TRIM(se.corner_3), '') IS NOT NULL OR
      NULLIF(TRIM(se.corner_4), '') IS NOT NULL
    )
  UNION ALL
  SELECT 'N' AS src,
         se.ketto_toroku_bango::text AS ketto_toroku_bango,
         se.kaisai_nen, se.kaisai_tsukihi, se.race_bango,
         se.corner_1, se.corner_2, se.corner_3, se.corner_4
  FROM public.nvd_se se
  WHERE se.ketto_toroku_bango::text = :'ketto'
    AND (CAST(se.kaisai_nen AS INTEGER)*10000 + CAST(se.kaisai_tsukihi AS INTEGER)) < :'target'
    AND COALESCE(NULLIF(TRIM(se.data_kubun), ''), '') IN ('6','7')
    AND (
      NULLIF(TRIM(se.corner_1), '') IS NOT NULL OR
      NULLIF(TRIM(se.corner_2), '') IS NOT NULL OR
      NULLIF(TRIM(se.corner_3), '') IS NOT NULL OR
      NULLIF(TRIM(se.corner_4), '') IS NOT NULL
    )
)
SELECT
  src,
  CAST(kaisai_nen AS INTEGER) AS year,
  CAST(kaisai_tsukihi AS INTEGER) AS mmdd,
  race_bango,
  corner_1, corner_2, corner_3, corner_4,
  -- Flatten present numbers across 1..4 (some courses may store only 3/4)
  array_to_string(ARRAY(
    SELECT unnest(ARRAY[
      NULLIF(TRIM(corner_1), ''),
      NULLIF(TRIM(corner_2), ''),
      NULLIF(TRIM(corner_3), ''),
      NULLIF(TRIM(corner_4), '')
    ])::text
  ), '-') AS pass_raw
FROM se_all
ORDER BY CAST(kaisai_nen AS INTEGER) DESC, CAST(kaisai_tsukihi AS INTEGER) DESC
LIMIT 3;


