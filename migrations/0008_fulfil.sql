-- W-FULFIL Stage B: per-tenant fulfilment settings (JSON; code-side defaults).
-- autopay defaults OFF — no order is paid/submitted to CJ until explicitly enabled.
ALTER TABLE tenant_config ADD COLUMN fulfil TEXT NOT NULL DEFAULT '{}';
