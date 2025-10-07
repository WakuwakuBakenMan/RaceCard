SELECT ketto_toroku_bango, kaisai_nen, kaisai_tsukihi, corner_1, corner_2, corner_3, corner_4 
FROM jvd_se 
WHERE ketto_toroku_bango IN ('2022110105', '2021100768') 
ORDER BY ketto_toroku_bango, CAST(kaisai_nen AS INTEGER) DESC, CAST(kaisai_tsukihi AS INTEGER) DESC 
LIMIT 10;
