-- W-ADDON: hidden add-on/filler lane settings (JSON column, code-side defaults)
ALTER TABLE tenant_config ADD COLUMN addons TEXT NOT NULL DEFAULT '{}';
