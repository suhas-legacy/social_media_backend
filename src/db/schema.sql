-- ============================================================
--  LEADS DASHBOARD — PostgreSQL Schema (No ORM, Raw SQL)
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────
-- ENUM TYPES
-- ─────────────────────────────────────────

CREATE TYPE user_role AS ENUM ('admin', 'employee');

CREATE TYPE lead_status AS ENUM (
  'new',
  'contacted',
  'interested',
  'not_interested',
  'converted',
  'lost'
);

CREATE TYPE lead_source AS ENUM (
  'linkedin',
  'twitter',
  'instagram',
  'facebook',
  'web_scrape',
  'other'
);

-- ─────────────────────────────────────────
-- USERS (Admin + Employees)
-- ─────────────────────────────────────────

CREATE TABLE users (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(150)  NOT NULL,
  email         VARCHAR(255)  UNIQUE NOT NULL,
  password_hash TEXT          NOT NULL,
  role          user_role     NOT NULL DEFAULT 'employee',
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- UPLOAD BATCHES
-- Each CSV/JSON upload from Apify is tracked as one batch
-- ─────────────────────────────────────────

CREATE TABLE upload_batches (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by     UUID          NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  file_name       VARCHAR(255),
  source_platform lead_source   NOT NULL DEFAULT 'other',
  total_leads     INTEGER       NOT NULL DEFAULT 0,
  assigned_to     UUID[]        DEFAULT '{}',   -- array of employee UUIDs
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- LEADS
-- ─────────────────────────────────────────

CREATE TABLE leads (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         UUID          REFERENCES upload_batches(id) ON DELETE SET NULL,

  -- Core contact info
  full_name        TEXT,
  email            VARCHAR(255),
  phone            VARCHAR(50),
  company          TEXT,
  job_title        TEXT,
  location         TEXT,
  website          TEXT,
  linkedin_url     TEXT,
  profile_image    TEXT,

  -- Source metadata
  source           lead_source   NOT NULL DEFAULT 'other',
  source_url       TEXT,
  apify_run_id     VARCHAR(150),
  raw_data         JSONB,                        -- full Apify payload preserved

  -- CRM fields
  status           lead_status   NOT NULL DEFAULT 'new',
  assigned_to      UUID          REFERENCES users(id) ON DELETE SET NULL,
  priority         SMALLINT      DEFAULT 0,      -- 0=normal,1=high,2=urgent
  tags             TEXT[]        DEFAULT '{}',

  -- Timestamps
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  contacted_at     TIMESTAMPTZ,
  converted_at     TIMESTAMPTZ
);

-- ─────────────────────────────────────────
-- LEAD NOTES / ACTIVITY LOG
-- ─────────────────────────────────────────

CREATE TABLE lead_notes (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID          NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id   UUID          NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT          NOT NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- LEAD STATUS HISTORY
-- ─────────────────────────────────────────

CREATE TABLE lead_status_history (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID         NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  changed_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
  from_status  lead_status,
  to_status    lead_status  NOT NULL,
  changed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────

CREATE INDEX idx_leads_assigned_to  ON leads(assigned_to);
CREATE INDEX idx_leads_status       ON leads(status);
CREATE INDEX idx_leads_source       ON leads(source);
CREATE INDEX idx_leads_batch_id     ON leads(batch_id);
CREATE INDEX idx_leads_email        ON leads(email);
CREATE INDEX idx_lead_notes_lead    ON lead_notes(lead_id);

-- ─────────────────────────────────────────
-- AUTO-UPDATE updated_at TRIGGER
-- ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_updated
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ─────────────────────────────────────────
-- SEED: Default Admin User
-- Password: admin123  (bcrypt hash — change in production!)
-- ─────────────────────────────────────────

INSERT INTO users (name, email, password_hash, role)
VALUES (
  'Super Admin',
  'admin@company.com',
  '$2b$10$7Qw6Kj9pXzL1mNvHuR3.2eHd5VvGbA8yKpW4rD6sT0uEqF1cI9jXG',
  'admin'
);
