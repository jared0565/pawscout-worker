/**
 * Strip a quoted reply chain from an inbound email body so the drafter and the
 * destination derivation ground on the customer's NEW text only - not the quoted
 * copy of our own previous reply.
 *
 * Two real bugs this fixes (seen live):
 *  - a quoted "On <date> Active Paw <support@activepaw.co.uk> wrote:" footer made the
 *    shipping derivation read the ".co.uk" as a UK destination (a Texas question got a
 *    "Delivery to the UK" line);
 *  - the quoted history made replies answer a stale earlier turn instead of the new ask.
 *
 * Conservative by design - handles the client styles in this inbox, not a full email
 * parser:
 *  - Gmail/Apple "On <date>, <name> <addr> wrote:" attribution (cut it and everything after)
 *  - Outlook "-----Original Message-----" / long underscore dividers / From:+Sent: blocks
 *  - stray ">"-quoted lines above the cut
 *
 * Returns the trimmed remainder, which MAY be empty when the message was only a quote
 * (the caller must NOT fabricate a reply in that case - reply with a brief acknowledgement).
 */
export function stripQuotedReply(text: string | null | undefined): string {
  if (!text) return '';
  const t = text.replace(/\r\n/g, '\n');

  // Earliest divider that introduces a quoted chain. `(?:^|\n)` so the match index
  // points at the line start; slicing there keeps the customer's own text.
  const cutters: RegExp[] = [
    /(?:^|\n)\s*On\s[\s\S]{0,300}?\bwrote:\s*(?:\n|$)/i, // Gmail / Apple Mail attribution
    /(?:^|\n)\s*-{2,}\s*Original Message\s*-{2,}/i,        // Outlook divider
    /(?:^|\n)\s*_{5,}\s*(?:\n|$)/,                         // Outlook underscore rule
    /(?:^|\n)\s*From:\s.+\n\s*(?:Sent|Date):\s/i,         // Outlook header block
  ];
  let cut = t.length;
  for (const re of cutters) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }

  const head = t
    .slice(0, cut)
    .split('\n')
    .filter((line) => !/^\s*>/.test(line)) // drop any stray quoted lines above the cut
    .join('\n');
  return head.trim();
}
