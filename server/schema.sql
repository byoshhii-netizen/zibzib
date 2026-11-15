CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  username text NOT NULL UNIQUE,
  display_name varchar(40) NOT NULL,
  password_hash text NOT NULL,
  avatar_url text,
  is_admin boolean NOT NULL DEFAULT false,
  is_disabled boolean NOT NULL DEFAULT false,
  email_verified boolean NOT NULL DEFAULT false,
  token_version integer NOT NULL DEFAULT 0,
  two_factor_type text CHECK (two_factor_type IN ('email', 'security_question', 'pin')),
  security_question text,
  security_answer_hash text,
  security_answer_case_sensitive boolean NOT NULL DEFAULT false,
  pin_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  avatar_url text,
  kind text NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct', 'group', 'self', 'broadcast')),
  message_policy text NOT NULL DEFAULT 'all' CHECK (message_policy IN ('all', 'admins', 'selected')),
  photo_policy text NOT NULL DEFAULT 'all' CHECK (photo_policy IN ('all', 'admins', 'none')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_allowed_senders (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text,
  attachment_url text,
  reply_to uuid REFERENCES messages(id) ON DELETE SET NULL,
  edited_at timestamptz,
  deleted_for_all boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_for_all OR body IS NOT NULL OR attachment_url IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS message_deletions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_visible boolean NOT NULL DEFAULT true,
  online_visible boolean NOT NULL DEFAULT true,
  read_receipts boolean NOT NULL DEFAULT true,
  show_photos_directly boolean NOT NULL DEFAULT true,
  app_theme text NOT NULL DEFAULT 'light' CHECK (app_theme IN ('light', 'dark')),
  chat_theme text NOT NULL DEFAULT 'light' CHECK (chat_theme IN ('light', 'dark')),
  chat_locked boolean NOT NULL DEFAULT false,
  lock_code_hash text,
  recovery_email text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('login_2fa', 'password_reset', 'lock_recovery', 'email_change')),
  code_hash text NOT NULL,
  target_value text,
  attempts smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_user_settings (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_muted boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  is_locked boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at timestamptz,
  read_at timestamptz,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  caller_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'accepted', 'rejected', 'missed', 'ended')),
  started_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS friendships_addressee_status_idx ON friendships (addressee_id, status);
CREATE INDEX IF NOT EXISTS members_user_idx ON conversation_members (user_id);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS message_policy text NOT NULL DEFAULT 'all';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS photo_policy text NOT NULL DEFAULT 'all';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_type text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_question text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_answer_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_answer_case_sensitive boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS app_theme text NOT NULL DEFAULT 'light';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS chat_theme text NOT NULL DEFAULT 'light';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS chat_locked boolean NOT NULL DEFAULT false;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS lock_code_hash text;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS recovery_email text;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS show_photos_directly boolean NOT NULL DEFAULT true;
ALTER TABLE user_settings DROP COLUMN IF EXISTS two_factor_type;
CREATE INDEX IF NOT EXISTS auth_challenges_expires_idx ON auth_challenges (expires_at);
CREATE INDEX IF NOT EXISTS message_receipts_user_idx ON message_receipts (user_id, read_at);
