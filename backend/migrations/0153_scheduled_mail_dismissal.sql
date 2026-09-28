-- Apply after 0152_scheduled_mail.sql. Dismissal acknowledges an uncertain outcome;
-- it does not recall a message or make it eligible for another submission.
ALTER TABLE scheduled_mail DROP CONSTRAINT scheduled_mail_state_check;
ALTER TABLE scheduled_mail ADD CONSTRAINT scheduled_mail_state_check CHECK (state IN
  ('pending', 'editing', 'preparing', 'sending', 'sent', 'partial', 'failed', 'uncertain', 'cancelled', 'dismissed'));
