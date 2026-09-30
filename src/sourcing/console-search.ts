import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import type { CjClient } from '../cj';
import { supplierOffers, type SupplierOffer } from './offers';
import { inquiryDestination } from './destination';

/** The console's supplier lookup for one thread: the customer's country from
 *  the thread (UK assumed, and said so, when it names none) and up to five
 *  offers. Never throws; a CJ failure is reported as an error line. */
export async function supplierSearchForThread(
  deps: { store: TenantStore; cj: CjClient; cfg: TenantConfig },
  q: string,
  threadId: string | null
): Promise<{ ok: true; dest: string; destKnown: boolean; offers: SupplierOffer[] } | { ok: false; error: string }> {
  try {
    const found = threadId ? await inquiryDestination(deps.store, threadId) : null;
    const dest = found ?? 'GB';
    const offers = await supplierOffers(deps.store, deps.cj, deps.cfg, q, dest, { limit: 5 });
    return { ok: true, dest, destKnown: found !== null, offers };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
