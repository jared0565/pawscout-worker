CREATE TABLE tenants (
  shop             TEXT PRIMARY KEY,
  access_token_enc TEXT NOT NULL,
  dek_wrapped      TEXT NOT NULL,
  scopes           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  installed_at     TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE supplier_credentials (
  shop         TEXT NOT NULL,
  supplier     TEXT NOT NULL,
  api_key_enc  TEXT NOT NULL,
  label        TEXT,
  validated_at TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (shop, supplier)
);

CREATE TABLE tenant_config (
  shop           TEXT PRIMARY KEY,
  collection_map TEXT NOT NULL DEFAULT '{}',
  gates          TEXT NOT NULL DEFAULT '{}',
  target         INTEGER NOT NULL DEFAULT 16,
  updated_at     TEXT NOT NULL
);
