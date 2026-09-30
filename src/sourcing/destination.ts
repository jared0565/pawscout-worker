import type { TenantStore } from '../tenant-store';
import { deriveDestinationCountry } from '../inbox/freight';
import { stripQuotedReply } from '../inbox/quote';

/** The inquirer's country from the thread's INBOUND text, quoted replies
 *  stripped (our own "activepaw.co.uk" footer would otherwise read as the UK),
 *  exactly as the draft composer derives it. Null when the thread names none. */
export async function inquiryDestination(store: TenantStore, threadId: string): Promise<string | null> {
  const got = await store.getThreadWithMessages(threadId);
  if (!got) return null;
  const conversation = got.messages
    .filter((m) => m.direction === 'inbound')
    .map((m) => stripQuotedReply(m.body_text ?? ''))
    .filter(Boolean)
    .join('\n\n---\n\n');
  return deriveDestinationCountry(conversation, got.thread.subject ?? '', got.thread.contact_email);
}
