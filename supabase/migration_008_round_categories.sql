-- Lets the admin restrict which categories are in play for a given round — e.g. Round 1 gets
-- 5 of the 11 categories, Round 2 gets the other 6, and rounds can reuse the same categories
-- if wanted. NULL (or empty array) means "all categories are fair game," so existing rounds
-- keep working exactly as before until the admin explicitly picks a subset.

ALTER TABLE rounds ADD COLUMN IF NOT EXISTS category_ids UUID[];
