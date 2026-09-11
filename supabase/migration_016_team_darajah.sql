-- Darajah (grade/level) for each team, shown as a second line under the team name on the admin
-- Teams page and on the Winners screen — e.g. "رغبة" / "الدرجة السادسة". Nullable: existing teams
-- keep working with no darajah, and the field is optional when adding a team.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS darajah TEXT;
