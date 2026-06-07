import { TenantStore } from '../tenant-store';

export async function handleUninstall(db: D1Database, shop: string): Promise<void> {
  const store = new TenantStore(db, shop);
  await store.setStatus('uninstalled');
  await store.deleteAllSecrets();
}
