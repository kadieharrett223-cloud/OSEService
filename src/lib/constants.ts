export const CASE_STATUSES = [
  "New",
  "In Progress",
  "Waiting for Customer",
  "Under Review",
  "Parts Needed",
  "Parts Ordered",
  "Parts Shipped",
  "Service Scheduled",
  "Completed",
  "Resolved",
  "Closed",
] as const;

export const CASE_TYPES = ["General", "Warranty", "Freight Damage"] as const;

export const PRIORITIES = ["Low", "Medium", "High"] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];
export type CasePriority = (typeof PRIORITIES)[number];
export type CaseType = (typeof CASE_TYPES)[number];

export const APP_NAME = "Olympic Equipment Service";
export const APP_SHORT_NAME = "OES Service Tracker";
