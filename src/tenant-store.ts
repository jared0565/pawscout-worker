import type { TenantRow, TenantConfig } from './types';

interface SupplierCredRow {
  shop: string; supplier: string; api_key_enc: string; label: string | null; validated_at: string | null; created_at: string;
}

export class TenantStore {
  constructor(private readonly db: D1Database, readonly shop: string) {}

  async upsertTenant(t: { accessTokenEnc: string; dekWrapped: string; scopes: string }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO tenants (shop, access_token_enc, dek_wrapped, scopes, status, installed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)
         ON CONFLICT(shop) DO UPDATE SET
           access_token_enc = ?2, dek_wrapped = ?3, scopes = ?4, status = 'active', updated_at = ?5`
      )
      .bind(this.shop, t.accessTokenEnc, t.dekWrapped, t.scopes, now)
      .run();
  }

  getTenant(): Promise<TenantRow | null> {
    return this.db.prepare(`SELECT * FROM tenants WHERE shop = ?1`).bind(this.shop).first<TenantRow>();
  }

  async setStatus(status: string): Promise<void> {
    await this.db.prepare(`UPDATE tenants SET status = ?2, updated_at = ?3 WHERE shop = ?1`)
      .bind(this.shop, status, new Date().toISOString()).run();
  }

  async seedConfig(cfg: TenantConfig): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tenant_config (shop, collection_map, gates, target, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(shop) DO UPDATE SET collection_map = ?2, gates = ?3, target = ?4, updated_at = ?5`
      )
      .bind(this.shop, JSON.stringify(cfg.collectionMap), JSON.stringify(cfg.gates), cfg.target, new Date().toISOString())
      .run();
  }

  async getConfig(): Promise<TenantConfig | null> {
    const row = await this.db
      .prepare(`SELECT collection_map, gates, target FROM tenant_config WHERE shop = ?1`)
      .bind(this.shop)
      .first<{ collection_map: string; gates: string; target: number }>();
    if (!row) return null;
    return { collectionMap: JSON.parse(row.collection_map), gates: JSON.parse(row.gates), target: row.target };
  }

  async putSupplierCredential(supplier: string, apiKeyEnc: string, label: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO supplier_credentials (shop, supplier, api_key_enc, label, validated_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(shop, supplier) DO UPDATE SET api_key_enc = ?3, label = ?4, validated_at = ?5`
      )
      .bind(this.shop, supplier, apiKeyEnc, label, now)
      .run();
  }

  getSupplierCredential(supplier: string): Promise<SupplierCredRow | null> {
    return this.db
      .prepare(`SELECT * FROM supplier_credentials WHERE shop = ?1 AND supplier = ?2`)
      .bind(this.shop, supplier)
      .first<SupplierCredRow>();
  }

  async deleteAllSecrets(): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM supplier_credentials WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`UPDATE tenants SET access_token_enc = '', dek_wrapped = '' WHERE shop = ?1`).bind(this.shop)
    ]);
  }
}
