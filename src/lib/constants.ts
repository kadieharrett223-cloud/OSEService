export const CASE_STATUSES = [
  "New",
  "Waiting for Customer",
  "Under Review",
  "Parts Needed",
  "Parts Ordered",
  "Parts Shipped",
  "Service Scheduled",
  "Resolved",
  "Closed",
] as const;

export const PRIORITIES = ["Low", "Medium", "High"] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];
export type CasePriority = (typeof PRIORITIES)[number];

export const APP_NAME = "Olympic Equipment Service";
export const APP_SHORT_NAME = "OES Service Tracker";
