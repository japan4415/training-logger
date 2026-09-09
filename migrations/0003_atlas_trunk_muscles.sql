-- Add the original BodyParts3D 3.0 latissimus dorsi and rectus abdominis meshes.
-- Only the three reviewed profiles that still match their 0002 defaults change.
-- Compare each sorted array so JSON whitespace, key order and selection order do
-- not matter. NULL, explicit empty and custom assignments/extra fields are kept.
-- Do not modify 0002, which has already been applied in production.
WITH replacements(names, previous, next) AS (
  VALUES
  ('["ラットプルダウン","Lat Pulldown"]',
   '{"primary":[],"secondary":["FJ1507","FJ1507M","FJ1478","FJ1478M","FJ1512","FJ1512M","FJ1486","FJ1486M","FJ1487","FJ1487M","FJ1520","FJ1520M","FJ1536","FJ1536M","FJ1537","FJ1537M"],"unavailable":["広背筋"]}',
   '{"primary":["FMA13358","FMA13359"],"secondary":["FJ1507","FJ1507M","FJ1478","FJ1478M","FJ1512","FJ1512M","FJ1486","FJ1486M","FJ1487","FJ1487M","FJ1520","FJ1520M","FJ1536","FJ1536M","FJ1537","FJ1537M"],"unavailable":[]}'),
  ('["シーテッドロウ","Seated Row"]',
   '{"primary":["FJ1536","FJ1536M","FJ1537","FJ1537M","FJ1554","FJ1554M"],"secondary":["FJ1478","FJ1478M","FJ1512","FJ1512M","FJ1486","FJ1486M","FJ1487","FJ1487M","FJ1513","FJ1513M","FJ1507","FJ1507M","FJ1520","FJ1520M"],"unavailable":["広背筋"]}',
   '{"primary":["FJ1536","FJ1536M","FJ1537","FJ1537M","FJ1554","FJ1554M","FMA13358","FMA13359"],"secondary":["FJ1478","FJ1478M","FJ1512","FJ1512M","FJ1486","FJ1486M","FJ1487","FJ1487M","FJ1513","FJ1513M","FJ1507","FJ1507M","FJ1520","FJ1520M"],"unavailable":[]}'),
  ('["レッグレイズ","Leg Raise"]',
   '{"primary":["FJ1422","FJ1422M","FJ1431","FJ1431M"],"secondary":["FJ1452","FJ1452M","FJ1433","FJ1433M"],"unavailable":["腹直筋"]}',
   '{"primary":["FJ1422","FJ1422M","FJ1431","FJ1431M"],"secondary":["FJ1452","FJ1452M","FJ1433","FJ1433M","FMA13377","FMA13378"],"unavailable":[]}')
)
UPDATE exercises
SET atlas_muscles = (
  SELECT next FROM replacements
  WHERE exercises.name COLLATE NOCASE IN (SELECT value FROM json_each(replacements.names))
)
WHERE atlas_muscles IS NOT NULL
  AND (SELECT count(*) FROM json_each(exercises.atlas_muscles)) = 3
  AND EXISTS (
    SELECT 1 FROM replacements
    WHERE exercises.name COLLATE NOCASE IN (SELECT value FROM json_each(replacements.names))
    AND json_type(exercises.atlas_muscles, '$.primary') = 'array'
    AND (SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(exercises.atlas_muscles, '$.primary') ORDER BY value
    )) = (SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(replacements.previous, '$.primary') ORDER BY value
    ))
    AND json_type(exercises.atlas_muscles, '$.secondary') = 'array'
    AND (SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(exercises.atlas_muscles, '$.secondary') ORDER BY value
    )) = (SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(replacements.previous, '$.secondary') ORDER BY value
    ))
    AND json_type(exercises.atlas_muscles, '$.unavailable') = 'array'
    AND (SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(exercises.atlas_muscles, '$.unavailable') ORDER BY value
    )) = (SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(replacements.previous, '$.unavailable') ORDER BY value
    ))
  );
