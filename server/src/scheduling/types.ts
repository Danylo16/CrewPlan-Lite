export const DAYS_OF_WEEK = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];
export type RequirementPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export interface AvailabilityInterval {
  dayOfWeek: DayOfWeek;
  startMinute: number;
  endMinute: number;
}

export interface EmployeeSkillInput {
  skillId: number;
  level: number;
}

export interface SchedulingEmployee {
  id: number;
  preferredWeeklyMinutes: number;
  maxWeeklyMinutes: number;
  skills: EmployeeSkillInput[];
  availability: AvailabilityInterval[];
}

export interface SchedulingRequirement {
  id: number;
  projectId: number;
  dayOfWeek: DayOfWeek;
  startMinute: number;
  endMinute: number;
  requiredEmployees: number;
  requiredSkillId: number | null;
  minimumSkillLevel: number;
  priority: RequirementPriority;
}

export interface ExistingShiftInput {
  employeeId: number;
  projectId: number;
  dayOfWeek: DayOfWeek;
  startMinute: number;
  endMinute: number;
}

export interface SchedulingInput {
  employees: SchedulingEmployee[];
  requirements: SchedulingRequirement[];
  existingShifts: ExistingShiftInput[];
  maxSearchNodes?: number;
}

export interface ProposedAssignment {
  requirementId: number;
  positionIndex: number;
  employeeId: number;
  projectId: number;
  dayOfWeek: DayOfWeek;
  startMinute: number;
  endMinute: number;
}

export type RejectionReason =
  | "NOT_AVAILABLE"
  | "MISSING_SKILL"
  | "OVERLAP"
  | "WEEKLY_LIMIT";

export interface UnfilledPosition {
  requirementId: number;
  positionIndex: number;
  projectId: number;
  dayOfWeek: DayOfWeek;
  startMinute: number;
  endMinute: number;
  priority: RequirementPriority;
  rejectionCounts: Record<RejectionReason, number>;
}

export interface SchedulingMetrics {
  requestedPositions: number;
  assignedPositions: number;
  existingPositions: number;
  proposedPositions: number;
  unfilledPositions: number;
  coveragePercent: number;
  assignedMinutes: number;
  penalty: number;
  exploredNodes: number;
  searchLimitReached: boolean;
  hardConflicts: 0;
}

export interface SchedulingResult {
  assignments: ProposedAssignment[];
  unfilledPositions: UnfilledPosition[];
  metrics: SchedulingMetrics;
}

export interface StaffingSlot extends SchedulingRequirement {
  positionIndex: number;
  durationMinutes: number;
}

export interface ScheduledInterval {
  dayOfWeek: DayOfWeek;
  startMinute: number;
  endMinute: number;
}
