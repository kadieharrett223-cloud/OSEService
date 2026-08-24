export type LogicalShipmentRecord<Line> = {
  id: string;
  shipment_number: string;
  logical_shipment_id?: string | null;
  idempotency_key?: string | null;
  lines?: Line[];
  document_count?: number;
};

export type LogicalShipmentGroup<Line, Shipment extends LogicalShipmentRecord<Line>> = Shipment & {
  owner_shipment_ids: string[];
  lines: Line[];
  document_count: number;
};

function shipmentGroupKey(shipment: LogicalShipmentRecord<unknown>) {
  if (shipment.logical_shipment_id) return `logical:${shipment.logical_shipment_id}`;

  const ownerSuffix = /^(.*):FULFILLMENT:[^:]+$/.exec(shipment.idempotency_key ?? "");
  if (ownerSuffix?.[1]) return `submission:${ownerSuffix[1]}`;

  return `owner:${shipment.id}`;
}

/**
 * Combines owner-level shipment records created by one customer fulfillment
 * submission without changing their persisted parent ownership.
 */
export function groupLogicalShipments<Line, Shipment extends LogicalShipmentRecord<Line>>(
  shipments: Shipment[],
): Array<LogicalShipmentGroup<Line, Shipment>> {
  const grouped = new Map<string, Shipment[]>();
  for (const shipment of shipments) {
    const key = shipmentGroupKey(shipment);
    grouped.set(key, [...(grouped.get(key) ?? []), shipment]);
  }

  return Array.from(grouped.values()).map((ownerShipments) => {
    const primary = ownerShipments[0]!;
    const isLogicalGroup = ownerShipments.length > 1;
    return {
      ...primary,
      id: isLogicalGroup ? `logical-${shipmentGroupKey(primary)}` : primary.id,
      owner_shipment_ids: ownerShipments.map((shipment) => shipment.id),
      lines: ownerShipments.flatMap((shipment) => shipment.lines ?? []),
      document_count: ownerShipments.reduce((total, shipment) => total + Number(shipment.document_count ?? 0), 0),
    };
  });
}