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
  sortOrder: number;
  requiredSkill: Skill;
  incomingDependencies: WorkPackageDependency[];
}

export interface WorkPackageDependency {
  predecessorId: number;
  successorId: number;
  lagMinutes: number;
}

export interface ProjectProgress {
  estimatedMinutes: number;
  completedMinutes: number;
  remainingMinutes: number;
  forecastMinutes: number;
  completionPercent: number;
  actualCostCents: number;
  remainingBudgetCents: number | null;
}

export interface ProjectDetails extends ProjectWithCount {
  workPackages: WorkPackage[];
  progress: ProjectProgress;
}

export interface FixedCoverageRequirement {
  id: number;
  projectId: number;
  dayOfWeek: DayOfWeek;
  startMinute: number;
  endMinute: number;
  requiredEmployees: number;
  requiredSkillId: number | null;
  minimumSkillLevel: number;
  priority: RequirementPriority;
  requiredSkill: Skill | null;
}

export interface WorkLog {
  id: number;
  employeeId: number;
  projectId: number;
  workPackageId: number;
  plannedAllocationId: number | null;
  startedAt: string;
  endedAt: string;
  status: "DRAFT" | "CONFIRMED" | "VOID";
  note: string | null;
  actualCostCents: number | null;
  remainingMinutesApplied: number | null;
  minutes: number;
  employee: Employee;
  project: Project;
  workPackage: WorkPackage;
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
  workPackageId: number | null;
  projectRequirementId: number | null;
  planningRunId: string | null;
  startAt: string;
  endAt: string;
  note: string | null;
  kind: "GENERAL" | "WORK_PACKAGE" | "FIXED_COVERAGE";
  origin: "MANUAL" | "SOLVER" | "LEGACY";
  status: "COMMITTED" | "CANCELLED";
  plannedCostCents: number | null;
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

export interface PortfolioPlanAssignment {
  employeeId: number;
  employeeName: string;
  projectId: number;
  projectName: string;
  workPackageId: number;
  workPackageName: string;
  startAt: string;
  endAt: string;
  plannedCostCents: number;
}

export interface PortfolioPlanWeek {
  weekStart: string;
  capacityMinutes: number;
  committedMinutes: number;
  proposedMinutes: number;
  utilizationPercent: number;
  plannedCostCents: number;
}

export interface PortfolioPlanPreview {
  previewId: string;
  inputVersion: string;
  horizonStart: string;
  horizonEndExclusive: string;
  horizonWeeks: number;
  timezone: string;
  replaceGenerated: boolean;
  assignments: PortfolioPlanAssignment[];
  fixedCoverageAssignments: Array<{
    employeeId: number;
    projectId: number;
    projectRequirementId: number;
    startAt: string;
    endAt: string;
    plannedCostCents: number;
  }>;
  unplannedWorkPackages: Array<{
    workPackageId: number;
    projectId: number;
    name: string;
    unplannedMinutes: number;
    reason: string;
  }>;
  weekSummaries: PortfolioPlanWeek[];
  warnings: Array<{ code: string; message: string; projectId?: number; weekStart?: string }>;
  metrics: {
    proposedWorkMinutes: number;
    proposedFixedCoverageMinutes: number;
    plannedCostCents: number;
    assignedWorkPackages: number;
    unplannedWorkPackages: number;
  };
}

export interface AppliedPortfolioPlan {
  planningRunId: string;
  previewId: string;
  createdShifts: number;
  deletedShifts: number;
  metrics: PortfolioPlanPreview["metrics"];
}
