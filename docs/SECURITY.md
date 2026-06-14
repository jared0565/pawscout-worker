# Security & Data Protection

Backs the attestations made for Shopify Protected Customer Data access. Concise
by design — PawScout is a single-operator app on Cloudflare Workers + D1,
fronting Shopify and the CJ fulfilment relay.

## Incident response policy

On a suspected or confirmed security incident (leaked token, unauthorised
access, supplier/data exposure):

1. **Contain** — rotate the Shopify app access token and `SHOPIFY_API_SECRET`,
   and the CJ relay token; if a tenant token may be compromised, clear
   `tenants.access_token_enc` to force a clean re-mint.
2. **Assess** — identify the affected orders/customers from D1 (`orders`,
   `product_links`) and what data was exposed.
3. **Notify** — inform affected customers without undue delay, and report to the
   ICO within 72 hours where UK GDPR requires.
4. **Record** — document the incident, cause, and remediation here (dated).

## Data protection summary

- **Minimisation** — only the order's Name, Address and Phone are processed, and
  only to fulfil/ship the order. No profiling, resale, or marketing use.
- **Customer PII is never sent to the AI/LLM provider** — curation only ever
  sees product data.
- **Encryption** — in transit (TLS everywhere); at rest (Cloudflare D1 storage
  encryption); app credentials additionally envelope-encrypted (AES-GCM).
- **Retention & erasure** — order data kept only as long as needed to fulfil and
  support the order. Shopify's mandatory privacy webhooks are implemented:
  `customers/redact` erases the named orders' PII, `customers/data_request` is
  logged for the operator to fulfil, and `shop/redact` purges all shop data
  (~48h after uninstall).
- **Access** — least-privilege; sealed tokens; 2FA on the Shopify and Cloudflare
  accounts; access logged via Cloudflare request logs + app processing logs.
- **Test/prod separation** — tests run on an isolated workerd DB; production D1
  is a separate database.
- **Subprocessors** — Cloudflare (hosting/storage, SOC 2 Type II / ISO 27001),
  CJdropshipping (fulfilment). No third-party security audit of PawScout itself.

## Incident log

_(none to date)_
