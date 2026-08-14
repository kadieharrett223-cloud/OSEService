/** HL, HK, FB and YZ are manufacturer abbreviations, not part of the product name. */
const MANUFACTURER_PREFIX = /^(HL|HK|FB|YZ)(?:-|\s)\s*/i;

export function splitProductTitle(name: string | null | undefined) {
  const raw = String(name ?? "").trim();
  const match = raw.match(MANUFACTURER_PREFIX);
  if (!match) return { manufacturer: null, title: raw };

  const title = raw.slice(match[0].length).trim();
  if (!title) return { manufacturer: null, title: raw };

  return { manufacturer: match[1].toUpperCase(), title };
}
