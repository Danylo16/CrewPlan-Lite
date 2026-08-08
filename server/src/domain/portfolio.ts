export const PROJECT_STATUSES = [
  "DRAFT",
  "PLANNED",
  "ACTIVE",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
  "ARCHIVED",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const DEADLINE_TYPES = ["NONE", "SOFT", "HARD"] as const;
export const PROJECT_PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export const OPTIMIZATION_STRATEGIES = [
  "BALANCED",
  "EARLIEST_COMPLETION",
  "MINIMIZE_COST",
  "MAXIMIZE_THROUGHPUT",
] as const;
export const WORK_PACKAGE_STATUSES = [
  "TODO",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;

const PROJECT_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  DRAFT: ["PLANNED", "CANCELLED"],
  PLANNED: ["DRAFT", "ACTIVE", "CANCELLED"],
  ACTIVE: ["ON_HOLD", "COMPLETED", "CANCELLED"],
  ON_HOLD: ["ACTIVE", "COMPLETED", "CANCELLED"],
  COMPLETED: ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canTransitionProject(
  from: ProjectStatus,
  to: ProjectStatus,
) {
  return PROJECT_TRANSITIONS[from].includes(to);
}

export function durationMinutes(startedAt: Date, endedAt: Date) {
  return Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000);
}

export function costForMinutes(hourlyCostCents: number, minutes: number) {
  return Math.round((hourlyCostCents * minutes) / 60);
}
