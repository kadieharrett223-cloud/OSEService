"use client";

import { useState } from "react";
import { reviewHistoricalQboIntakeAction } from "./actions";

const choices = [
  ["APPROVED", "Approve / Import Demand"],
  ["ALREADY_SATISFIED", "Already satisfied / Do not import"],
  ["DUPLICATE", "Duplicate / Keep out"],
  ["CLOSED", "Cancelled / Closed"],
] as const;

export function HistoricalIntakeAction({ qboInvoiceLineId }: { qboInvoiceLineId: string }) {
  const [disposition, setDisposition] = useState<(typeof choices)[number][0]>("APPROVED");
  const [confirming, setConfirming] = useState(false);
  return <form action={reviewHistoricalQboIntakeAction} className="flex min-w-56 flex-col gap-1"><input type="hidden" name="qbo_invoice_line_id" value={qboInvoiceLineId} /><select name="disposition" value={disposition} onChange={(event) => { setDisposition(event.target.value as (typeof choices)[number][0]); setConfirming(false); }} className="input text-xs">{choices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input name="review_note" className="input text-xs" placeholder="Review note" />{disposition === "APPROVED" && !confirming ? <button type="button" className="btn-primary text-xs" onClick={() => setConfirming(true)}>Review approval</button> : <button type="submit" className={disposition === "APPROVED" ? "btn-danger text-xs" : "btn-secondary text-xs"}>{disposition === "APPROVED" ? "Confirm import demand" : "Record decision"}</button>}{confirming ? <p className="text-xs text-[#b91c1c]">Creates only this exact QBO-line demand after live guard checks. No inventory or fulfillment changes.</p> : null}</form>;
}