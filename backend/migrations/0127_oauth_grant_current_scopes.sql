-- NA-05: `scopes` remains consent history. It cannot prove the privileges of the
-- access token stored by a later, narrower OAuth response, so current generation
-- capabilities live separately. Existing grants deliberately stay NULL: their
-- historical union must not be relabelled as a verified current-token scope set.
ALTER TABLE oauth_grants
  ADD COLUMN IF NOT EXISTS current_scopes TEXT[];
