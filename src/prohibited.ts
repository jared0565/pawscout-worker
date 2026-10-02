/**
 * Items the shop never offers, whatever the search or the import path (owner,
 * 2026-10-02): aversive training devices. Using an electric shock collar on a
 * dog is banned in England (since February 2024) and in Wales, and a pet-care
 * shop does not sell them. An overseas card showed one titled "Smart GPS
 * Wireless Fence Dog Training Collar": its listing said "shock" only in its
 * images, so the category words count as well as the shock words.
 *
 * Kept on purpose: shock-absorbing leads ("anti-shock", "shockproof"), the
 * Elizabethan recovery cone (a bare "e-collar"), and GPS trackers that only
 * alert the owner's phone ("invisible fence notification").
 */
const PATTERNS: readonly RegExp[] = [
  // Shock or static named as a mode, a correction or a stimulus.
  /\b(?:electric(?:al)?|static)\s+(?:shock|stimulation|correction|electricity|pulse)/i,
  // "shock" as a word, except the shock-absorbing and anti-shock lead family.
  /(?<!\banti[\s-]?)\bshock\b(?![\s-]*(?:absorb\w*|proof|resist\w*))/i,
  // Containment fences: a wireless, electronic or GPS fence corrects the dog
  // ("Wireless GPS Dog Fence GPS Dog Collar", a US card on 2026-10-02).
  /\b(?:wireless|electronic|electric|gps)\s+(?:gps\s+)?(?:dog\s+|pet\s+)?fence\b/i,
  // Remote and electronic trainers are the e-collar category.
  /\b(?:remote|electronic|electric|wireless|gps)\s+(?:dog\s+|pet\s+)?(?:training\s+collar|trainer|training\s+device)/i,
  // ...and the same trainer with the remote named last (one was listed June to
  // August 2026 with "static stimulation" in its description).
  /\b(?:training\s+collar|trainer)\s+with\s+(?:a\s+)?remote\b/i,
  // An electric collar, with up to two animal words and "training" between
  // ("800M Electric Pet Dog Training E-Collar", a GB card on 2026-10-02). A
  // colour ("Electric Blue Dog Collar") puts another word in the way.
  /\b(?:electric|electronic)\s+(?:(?:dog|pet|cat)\s+){0,2}(?:training\s+)?(?:e-?)?collar\b/i,
  // A "training e-collar" is the remote trainer; the recovery cone is never "training".
  /\btraining\s+e-?collar\b/i,
];

/** The words that make an item prohibited, or null when it is allowed. */
export function prohibitedItemReason(text: string): string | null {
  for (const p of PATTERNS) {
    const m = p.exec(text || '');
    if (m) return m[0];
  }
  return null;
}

/** The same test over everything a supplier detail says: title, description and variant names. */
export function prohibitedInDetail(d: { nameEn: string; descriptionHtml?: string | null; variants?: readonly { name: string }[] }): string | null {
  return prohibitedItemReason([d.nameEn, d.descriptionHtml ?? '', ...(d.variants ?? []).map((v) => v.name)].join(' \n '));
}
