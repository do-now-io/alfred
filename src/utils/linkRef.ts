/** Percent-encode a wikilink/task reference for embedding in an internal-link
 *  href (`wikilink:<ref>` / `task:<ref>`) — `encodeURIComponent` leaves `(` `)`
 *  untouched, which would otherwise break `[text](url)` markdown syntax. Used
 *  on both ends (encode here, `decodeURIComponent` in `useInternalLink`) so
 *  refs containing spaces/accents/parentheses round-trip correctly. */
export function encodeLinkRef(ref: string): string {
  return encodeURIComponent(ref).replace(/\(/g, "%28").replace(/\)/g, "%29");
}
