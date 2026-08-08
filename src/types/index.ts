export interface Employee {
  id: number;
  name: string;
  email: string;
  role: string;
  preferredWeeklyMinutes: number;
  maxWeeklyMinutes: number;
  hourlyCostCents: number;
  overtimeRateBasisPoints: number;
  archivedAt: string | null;
  archiveReason: string | null;
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
  totalLaborBudgetCents: number | null;
  status: ProjectStatus;
  startDate: string | null;
  targetEndDate: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  deadlineType: DeadlineType;
  priority: ProjectPriority;
  optimizationStrategy: OptimizationStrategy;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithCount extends Project {
  shiftCount: number;
  requirementCount: number;
  workPackageCount: number;
  workLogCount: number;
}

export type ProjectStatus =
  | "DRAFT" | "PLANNED" | "ACTIVE" | "ON_HOLD"
  | "COMPLETED" | "CANCELLED" | "ARCHIVED";

export type DeadlineType = "NONE" | "SOFT" | "HARD";
export type ProjectPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
export type OptimizationStrategy =
  | "BALANCED" | "EARLIEST_COMPLETION"
  | "MINIMIZE_COST" | "MAXIMIZE_THROUGHPUT";

export interface WorkPackage {
  id: number;
  projectId: number;
  name: string;
  description: string | null;
  status: "TODO" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  requiredSkillId: number;
  minimumSkillLevel: number;
  estimatedMinutes: number;
  remainingMinutes: number;
  completedMinutes: number;
  maxParallelEmployees: number;
  earliestStartDate: string | null;
  targetEndDate: string | null;
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
