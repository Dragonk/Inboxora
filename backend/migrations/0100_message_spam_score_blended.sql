-- Final blended antispam score, stored alongside the ML probability.
--
-- spam_score_ml holds the raw ML probability (or the rules score when ML is
-- inactive), but the verdict and auto-move are decided on the BLENDED score
-- (rules/ML mix by training maturity). A reader showing spam_score_ml could
-- therefore render "Spam · 70%" for a message whose blended score crossed
-- 85%, or "Unsure · 99%" when strong ML was pulled down by the rules. This
-- column is the score the classification actually decided on.
-- Apply before deploying code that writes or projects spam_score_blended.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS spam_score_blended FLOAT;
