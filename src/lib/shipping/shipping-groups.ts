export type DeliveryAddress = {
  city: string;
  state: string;
  zip: string;
  street: string;
  country: string;
};
export type ShippingLift = {
  sku: string;
  quantity: number;
  packageLabel: string;
  unitWeight: number | null;
  queuePosition: string;
};
export type ShippingCandidate = {
  orderId: string;
  invoice: string;
  customer: string;
  priorityDate: string | null;
  orderDate: string | null;
  address: DeliveryAddress | null;
  addressIssue: string | null;
  point: [number, number] | null;
  lifts: ShippingLift[];
  instructions: string;
};
const states = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(
    " ",
  ),
);
const clean = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** Invoice ShipAddr only. Never fall back to BillAddr or customer defaults. */
export function invoiceDeliveryAddress(raw: unknown): {
  address: DeliveryAddress | null;
  issue: string | null;
} {
  const a =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const country = clean(a.Country).toUpperCase();
  let city = clean(a.City),
    state = clean(a.CountrySubDivisionCode).toUpperCase(),
    postal = clean(a.PostalCode);
  const addressLines = ["Line1", "Line2", "Line3", "Line4", "Line5"]
    .map((k) => clean(a[k]))
    .filter(Boolean);
  // QBO often stores the invoice destination as free-text lines. Parse only
  // one complete, anchored city/state/ZIP line; never infer from notes or phones.
  if (!city && !state && !postal) {
    const matches = addressLines
      .map((line) =>
        line.match(
          /^([A-Za-z][A-Za-z. '\-]*),\s*([A-Z]{2})\s+([0-9]{5}(?:-[0-9]{4})?)$/,
        ),
      )
      .filter((m) => m !== null);
    if (matches.length === 1) [city, state, postal] = matches[0].slice(1, 4);
  }
  const street = addressLines.join(", ");
  if (/see\s+notes|address\s+(?:TBD|to be determined)/i.test(street))
    return {
      address: null,
      issue:
        "Invoice says to see notes / confirm address. Confirm the actual delivery location before grouping.",
    };
  if (!street || !city || !state || !postal)
    return {
      address: null,
      issue:
        "Missing invoice ship-to street, city, state or ZIP. Confirm the delivery address in QBO; no customer default was substituted.",
    };
  if (
    country &&
    !["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(
      country,
    )
  )
    return {
      address: null,
      issue: "International delivery: manual routing review required.",
    };
  if (!states.has(state) || !/^\d{5}(?:-\d{4})?$/.test(postal))
    return {
      address: null,
      issue: "Unrecognized US state or ZIP: verify invoice ship-to.",
    };
  if (/\bP\.?\s*O\.?\s*BOX\b/i.test(street))
    return {
      address: null,
      issue: "PO Box: confirm a physical freight delivery location.",
    };
  const hasStreetLine = addressLines.some(
    (line) =>
      /[0-9]/.test(line) &&
      /[A-Za-z]/.test(line) &&
      !/@|\b(?:phone|tel|call)\b/i.test(line) &&
      !/^([A-Za-z][A-Za-z. '\-]*),\s*([A-Z]{2})\s+([0-9]{5}(?:-[0-9]{4})?)$/.test(
        line,
      ),
  );
  if (!hasStreetLine)
    return {
      address: null,
      issue:
        "Physical street address is missing or unrecognized; confirm delivery location.",
    };
  return {
    address: { city, state, zip: postal.slice(0, 5), street, country: "US" },
    issue: null,
  };
}

/** Approximate straight-line distance between Census ZCTA representative points. */
export function zipMiles(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 +
    Math.cos(a[0] * rad) *
      Math.cos(b[0] * rad) *
      Math.sin(((b[1] - a[1]) * rad) / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function ageDays(date: string | null, now: Date) {
  const parsed = Date.parse(date ?? "");
  return Number.isFinite(parsed)
    ? Math.max(0, Math.floor((now.getTime() - parsed) / 86400000))
    : null;
}
export function mustShipSeparately(
  candidate: ShippingCandidate,
  now: Date,
  maxWaitDays: number,
) {
  const age = ageDays(candidate.orderDate, now);
  return (
    /\bASAP\b|as soon as possible/i.test(candidate.instructions) ||
    (age !== null && age >= maxWaitDays)
  );
}
export function groupShippingCandidates(
  candidates: ShippingCandidate[],
  maxMiles: number,
  maxWaitDays: number,
  now: Date,
) {
  const sorted = candidates
    .slice()
    .sort(
      (a, b) =>
        (Date.parse(a.priorityDate ?? "") || Number.MAX_SAFE_INTEGER) -
          (Date.parse(b.priorityDate ?? "") || Number.MAX_SAFE_INTEGER) ||
        a.orderId.localeCompare(b.orderId),
    );
  const review = sorted.filter((c) => !c.address || !c.point);
  const groups: Array<{
    orders: ShippingCandidate[];
    maxMiles: number;
    doNotDelay: boolean;
  }> = [];
  for (const candidate of sorted.filter((c) => c.address && c.point)) {
    // Geography may trigger an immediate comparison, never permission to delay an old/ASAP order.
    const urgent = mustShipSeparately(candidate, now, maxWaitDays);
    const group = groups.find(
      (g) =>
        g.orders.length < 10 &&
        g.orders.every((c) => zipMiles(c.point!, candidate.point!) <= maxMiles),
    );
    if (!group)
      groups.push({ orders: [candidate], maxMiles: 0, doNotDelay: urgent });
    else {
      group.maxMiles = Math.max(
        group.maxMiles,
        ...group.orders.map((c) => zipMiles(c.point!, candidate.point!)),
      );
      group.orders.push(candidate);
      group.doNotDelay ||= urgent;
    }
  }
  return { groups, review };
}
