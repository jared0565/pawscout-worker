import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import type { CjClient, CjDetail } from '../cj';
import { bestLocalQty, inquiryWarehouses, localWarehousesFor } from '../local-markets';
import { getDetailPreferWarehouse } from '../proxy/import';
import { laneRouteFor } from './lane-route';

export interface InquiryImportDeps {
  store: TenantStore;
  cj: CjClient;
  cfg: TenantConfig;
  /** confirmAndImport with the route's curate/pickHero/competitorCheck and the given warehouses. */
  runImport: (detail: CjDetail, localWarehouses: string[]) => Promise<unknown>;
  waitUntil: (p: Promise<unknown>) => void;
}

export type InquiryImportResult =
  | { ok: true; state: 'importing' | 'imported'; handle: string | null }
  | { ok: false; error: 'unknown_product' | 'not_deliverable' | 'no_stock' | 'stock_unknown' };

/**
 * Owner-triggered import of a supplier item for a customer's inquiry (owner
 * rule 2026-09-30). Local stock uses the lane alone; an item only the China
 * hub stocks may use the lane plus CN, and only when a fresh route reaches
 * the buyer. confirmAndImport runs in the background with every gate intact.
 */
export async function startInquiryImport(deps: InquiryImportDeps, pid: string, dest: string): Promise<InquiryImportResult> {
  const { store, cj, cfg } = deps;
  const link = await store.getLink(pid);
  if (link?.state === 'imported') return { ok: true, state: 'imported', handle: link.handle };
  if (link?.state === 'importing') return { ok: true, state: 'importing', handle: null };

  const detail = await getDetailPreferWarehouse(store, cj, pid);
  if (!detail) return { ok: false, error: 'unknown_product' };
  // Live stock by warehouse, always: the detail may be a 30-day-old cache, and
  // confirmAndImport skips its own origins lookup when origins are supplied.
  let origins: Record<string, number>;
  try { origins = await cj.originsByPid(pid); } catch { return { ok: false, error: 'stock_unknown' }; }
  const route = await laneRouteFor(store, cfg, origins, dest);
  if (!route) return { ok: false, error: 'not_deliverable' };
  const warehouses = route.overseas ? inquiryWarehouses(dest) : localWarehousesFor(dest);
  if (bestLocalQty(origins, warehouses) < cfg.floors.stockFloor) return { ok: false, error: 'no_stock' };

  await store.putLink({ cjPid: pid, state: 'importing' });
  deps.waitUntil(
    deps.runImport({ ...detail, origins }, warehouses).catch(async (e) => {
      // A thrown import would otherwise leave the link 'importing' forever and
      // block every retry; the gates' own refusals already write 'failed'.
      await store.putLink({ cjPid: pid, state: 'failed', failReason: 'import-error', failDetail: String((e as Error).message).slice(0, 200) });
    })
  );
  return { ok: true, state: 'importing', handle: null };
}

/** The console's poll: where the import stands, and why it failed if it did. */
export async function inquiryImportStatus(store: TenantStore, pid: string): Promise<{ ok: true; state: string; handle: string | null; failReason: string | null; failDetail: string | null }> {
  const link = await store.getLink(pid);
  return {
    ok: true,
    state: link?.state ?? 'unknown',
    handle: link?.state === 'imported' ? link.handle : null,
    failReason: link?.fail_reason ?? null,
    failDetail: link?.fail_detail ?? null,
  };
}
