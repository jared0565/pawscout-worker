-- Phase-1 foundation for origin-aware shipping cost: persist the cheapest CJ freight
-- price (USD) per synced route alongside the existing transit-time fields. Nullable:
-- a route with no priced option (or not yet synced) stays NULL => no cost claim.
-- Spec: docs/superpowers/specs/2026-06-25-shipping-cost-origin-profiles-phase1-design.md
ALTER TABLE cj_logistics ADD COLUMN freight_cost_usd REAL;
