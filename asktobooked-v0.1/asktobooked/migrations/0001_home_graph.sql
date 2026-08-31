PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  industry TEXT NOT NULL DEFAULT 'HVAC',
  city TEXT,
  state TEXT,
  service_area TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  booking_url TEXT,
  logo_url TEXT,
  average_job_value REAL NOT NULL DEFAULT 0,
  monitoring_fee REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS homeowners (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  contact_status TEXT NOT NULL DEFAULT 'unknown' CHECK(contact_status IN ('unknown','consented','transactional_only','unsubscribed','invalid')),
  marketing_opt_in_at TEXT,
  marketing_opt_out_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  homeowner_id TEXT,
  address_line_1 TEXT NOT NULL,
  address_line_2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  normalized_address TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (homeowner_id) REFERENCES homeowners(id) ON DELETE SET NULL,
  UNIQUE (organization_id, normalized_address)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  category TEXT NOT NULL,
  manufacturer TEXT,
  model TEXT,
  serial_number TEXT,
  install_date TEXT,
  warranty_expiration TEXT,
  estimated_lifespan_years REAL NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS service_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  homeowner_id TEXT,
  asset_id TEXT,
  type TEXT NOT NULL,
  service_date TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  external_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
  FOREIGN KEY (homeowner_id) REFERENCES homeowners(id) ON DELETE SET NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  homeowner_id TEXT,
  asset_id TEXT,
  source_service_event_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  estimated_value REAL NOT NULL DEFAULT 0,
  actual_value REAL,
  due_date TEXT,
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','booked','won','lost','dismissed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
  FOREIGN KEY (homeowner_id) REFERENCES homeowners(id) ON DELETE SET NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
  FOREIGN KEY (source_service_event_id) REFERENCES service_events(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  property_id TEXT,
  homeowner_id TEXT,
  opportunity_id TEXT,
  type TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'completed',
  source TEXT,
  value REAL,
  metadata_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL,
  FOREIGN KEY (homeowner_id) REFERENCES homeowners(id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  homeowner_id TEXT,
  opportunity_id TEXT,
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  estimated_value REAL NOT NULL DEFAULT 0,
  actual_value REAL,
  external_booking_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
  FOREIGN KEY (homeowner_id) REFERENCES homeowners(id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS home_record_access (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL UNIQUE,
  homeowner_id TEXT,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('created','invited','claimed','revoked')),
  claimed_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
  FOREIGN KEY (homeowner_id) REFERENCES homeowners(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS visibility_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  ai_mention_rate REAL NOT NULL DEFAULT 0,
  local_visibility REAL NOT NULL DEFAULT 0,
  website_conversion REAL NOT NULL DEFAULT 0,
  qualified_leads INTEGER NOT NULL DEFAULT 0,
  booked_jobs INTEGER NOT NULL DEFAULT 0,
  new_reviews INTEGER NOT NULL DEFAULT 0,
  response_minutes REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS visibility_queries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Unknown',
  competitor TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  event_key TEXT NOT NULL,
  description TEXT,
  channel TEXT NOT NULL DEFAULT 'Opportunity',
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE (organization_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_homeowners_org ON homeowners(organization_id);
CREATE INDEX IF NOT EXISTS idx_homeowners_email ON homeowners(organization_id, email);
CREATE INDEX IF NOT EXISTS idx_properties_org ON properties(organization_id);
CREATE INDEX IF NOT EXISTS idx_properties_homeowner ON properties(homeowner_id);
CREATE INDEX IF NOT EXISTS idx_assets_property ON assets(property_id);
CREATE INDEX IF NOT EXISTS idx_service_property_date ON service_events(property_id, service_date DESC);
CREATE INDEX IF NOT EXISTS idx_service_org_type_status ON service_events(organization_id, type, status);
CREATE INDEX IF NOT EXISTS idx_opportunity_org_status_due ON opportunities(organization_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_opportunity_property ON opportunities(property_id);
CREATE INDEX IF NOT EXISTS idx_interaction_homeowner_date ON interactions(homeowner_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_booking_property ON bookings(property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_home_record_token ON home_record_access(token);
