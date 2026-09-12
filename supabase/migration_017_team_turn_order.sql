-- Seating / turn order for teams. The admin fixes this before the show: seat 1 is where the
-- rotation starts, then 2, 3, ... and "Next Team" on the host console walks it in this order,
-- skipping eliminated teams and wrapping back to the top. Before this, the host console advanced
-- alphabetically by team name — which has nothing to do with where the teams are actually sitting,
-- and for Arabic names is effectively arbitrary to the eye.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS turn_order INTEGER;

-- Backfill every existing team with a seat, numbered per quiz in the order the admin screen
-- happened to show them (by name), so nothing is left null and the admin only has to reorder
-- rather than assign from scratch.
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY quiz_id ORDER BY name) AS rn
  FROM teams
)
UPDATE teams t
SET turn_order = o.rn
FROM ordered o
WHERE o.id = t.id AND t.turn_order IS NULL;
