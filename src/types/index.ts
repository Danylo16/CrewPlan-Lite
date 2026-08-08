export interface Employee {
  id: number;
  name: string;
  email: string;
  role: string;
  preferredWeeklyMinutes: number;
  maxWeeklyMinutes: number;
  hourlyCostCents: number;
  overtimeRateBasisPoints: number;
  skills: EmployeeSkill[];
  availability: EmployeeAvailability[];
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: number;
  name: string;
  color: string;
  weeklyLaborBudgetCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithCount extends Project {
  shiftCount: number;
  requirementCount: number;
}

export interface Skill {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type DayOfWeek =
  | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY"
  | "FRIDAY" | "SATURDAY" | "SUNDAY";

export interface EmployeeSkill {
  employeeId: number;
  skillId: number;
  level: number;
  skill: Skill;
}

export interface EmployeeAvailability {
  id: number;
  employeeId: number;
  dayOfWeek: DayOfWeek;
  startMinute: number;
  endMinute: number;
}

export interface Shift {
  id: number;
  employeeId: number;
  projectId: number;
  startAt: string;
  endAt: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  employee: Employee;
  project: Project;
}

export interface Holiday {
  id: string;
  date: string;
  endDate: string;
  name: string;
  nationwide: boolean;
}

export type RequirementPriority =
  | "LOW"
  | "NORMAL"
  | "HIGH"
  | "CRITICAL";

export interface ProposedAssignment {
  requirementId: number;
  positionIndex: number;
  employeeId: number;
  projectId: number;
  dayOfWeek: string;
  startMinute: number;
  endMinute: number;
  startAt: string;
  endAt: string;
}

export interface UnfilledRequirement {
  requirementId: number;
  positionIndex: number;
  projectId: number;
  dayOfWeek: string;
  startMinute: number;
  endMinute: number;
  priority: RequirementPriority;
  rejectionCounts: {
    NOT_AVAILABLE: number;
    MISSING_SKILL: number;
    OVERLAP: number;
    WEEKLY_LIMIT: number;
  };
}

export interface ScheduleMetrics {
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
  hardConflicts: number;
}

export interface SchedulePreview {
  previewId: string;
  inputVersion: string;
  weekStart: string;
  timezone: string;
  replaceExisting: boolean;
  assignments: ProposedAssignment[];
  unfilledRequirements: UnfilledRequirement[];
  metrics: ScheduleMetrics;
}

export interface AppliedSchedule {
  previewId: string;
  inputVersion: string;
  createdShifts: number;
  deletedShifts: number;
  metrics: ScheduleMetrics;
}
