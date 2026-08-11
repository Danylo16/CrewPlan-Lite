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
  regularMinutes: number;
  overtimeMinutes: number;
  regularCostCents: number;
  overtimeCostCents: number;
  plannedCostCents: number;
}

export interface PortfolioPlanCostAllocation {
  employeeId: number;
  projectId: number;
  projectRequirementId: number;
  startAt: string;
  endAt: string;
  regularMinutes: number;
  overtimeMinutes: number;
  regularCostCents: number;
  overtimeCostCents: number;
  plannedCostCents: number;
}

export interface PortfolioPlanWeek {
  weekStart: string;
  capacityMinutes: number;
  committedMinutes: number;
  proposedMinutes: number;
  utilizationPercent: number;
  regularMinutes: number;
  overtimeMinutes: number;
  regularCostCents: number;
  overtimeCostCents: number;
  retainedCostCents: number;
  fixedCoverageCostCents: number;
  workPackageCostCents: number;
  plannedCostCents: number;
}

export interface PortfolioPlanCostBaseline {
  plannedMinutes: number;
  unplannedMinutes: number;
  overtimeMinutes: number;
  laborCostCents: number;
}

export type PlanningProfile =
  | "BALANCED"
  | "COST_FIRST"
  | "DEADLINE_FIRST"
  | "RESILIENCE_FIRST";

export interface PortfolioOptimizerDiagnostics {
  algorithmVersion: string;
  strategy: string;
  planningProfile: PlanningProfile;
  beamWidth: number;
  packageVariantWidth: number;
  branchWidth: number;
  orderExploredStates: number;
  placementExploredStates: number;
  orderPrunedStates: number;
  placementPrunedStates: number;
  placementStateLimit: number;
  exploredStates: number;
  prunedStates: number;
  dominancePrunedStates: number;
  evaluatedPlans: number;
  searchLimitReached: boolean;
  runtimeMs: number;
  objectiveVector: {
    criticalUnplannedMinutes: number;
    highUnplannedMinutes: number;
    normalUnplannedMinutes: number;
    lowUnplannedMinutes: number;
    hardDeadlineExposureMinutes: number;
    softDeadlineExposureMinutes: number;
    overtimeMinutes: number;
    laborCostCents: number;
    imbalanceBasisPoints: number;
    singlePointExposureMinutes: number;
    maxRecoveryShortfallMinutes: number;
    skillConcentrationBasisPoints: number;
  };
  greedyBaseline: PortfolioPlanCostBaseline;
  v1Baseline: PortfolioPlanCostBaseline;
  optimized: PortfolioPlanCostBaseline;
  improvement: PortfolioPlanCostBaseline;
  improvementVsV1: PortfolioPlanCostBaseline;
}

export interface PortfolioPlanningScenario {
  planningProfile: PlanningProfile;
  previewId: string;
  inputVersion: string;
  proposedWorkMinutes: number;
  unplannedWorkPackages: number;
  unplannedMinutes: number;
  overtimeMinutes: number;
  workPackageCostCents: number;
  plannedCostCents: number;
  hardDeadlineExposureMinutes: number;
  softDeadlineExposureMinutes: number;
  singlePointExposureMinutes: number;
  maxRecoveryShortfallMinutes: number;
  skillConcentrationBasisPoints: number;
  optimizerRuntimeMs: number;
  orderExploredStates: number;
  placementExploredStates: number;
  orderPrunedStates: number;
  placementPrunedStates: number;
  placementStateLimit: number;
  exploredStates: number;
  prunedStates: number;
  dominancePrunedStates: number;
  candidateCount: number;
  searchLimitReached: boolean;
}

export interface PortfolioScenarioComparison {
  comparisonId: string;
  horizonStart: string;
  horizonWeeks: number;
  replaceGenerated: boolean;
  comparisonMode: "SHARED_PARETO_FRONTIER";
  runtimeMs: number;
  scenarios: PortfolioPlanningScenario[];
}

export interface PortfolioProjectCostWeek {
  weekStart: string;
  plannedCostCents: number;
  weeklyBudgetCents: number | null;
  weeklyBudgetVarianceCents: number | null;
}

export interface PortfolioProjectCostSummary {
  projectId: number;
  projectName: string;
  actualCostCents: number;
  retainedCostCents: number;
  fixedCoverageCostCents: number;
  workPackageCostCents: number;
  regularMinutes: number;
  overtimeMinutes: number;
  regularCostCents: number;
  overtimeCostCents: number;
  plannedCostCents: number;
  knownCostCents: number;
  totalBudgetCents: number | null;
  totalBudgetVarianceCents: number | null;
  forecastComplete: boolean;
  weeks: PortfolioProjectCostWeek[];
}

export interface PortfolioResilienceScenario {
  employeeId: number;
  employeeName: string;
  affectedAllocations: number;
  affectedMinutes: number;
  recoveredMinutes: number;
  lostMinutes: number;
  coveragePercent: number;
  criticalGapsAtRisk: number;
  additionalCostCents: number | null;
  recoverable: boolean;
  runtimeMs: number;
}

export interface PortfolioResilienceReport {
  previewId: string;
  inputVersion: string;
  horizonStart: string;
  horizonEndExclusive: string;
  horizonWeeks: number;
  algorithmVersion: string;
  strategy: string;
  scorePercent: number;
  averageCoveragePercent: number;
  worstCaseCoveragePercent: number;
  testedAbsences: number;
  recoverableAbsences: number;
  criticalGapsAtRisk: number;
  maxRequiredReassignments: number;
  employeesWithNoFullReplacement: string[];
  worstCaseEmployee: string | null;
  baselineAllocatedMinutes: number;
  runtimeMs: number;
  scenarios: PortfolioResilienceScenario[];
}

export interface PortfolioPlanPreview {
  previewId: string;
  inputVersion: string;
  horizonStart: string;
  horizonEndExclusive: string;
  horizonWeeks: number;
  planningProfile: PlanningProfile;
  timezone: string;
  replaceGenerated: boolean;
  assignments: PortfolioPlanAssignment[];
  fixedCoverageAssignments: PortfolioPlanCostAllocation[];
  unplannedWorkPackages: Array<{
    workPackageId: number;
    projectId: number;
    name: string;
    unplannedMinutes: number;
    reason: string;
  }>;
  weekSummaries: PortfolioPlanWeek[];
  projectCostSummaries: PortfolioProjectCostSummary[];
  resilienceCandidates: Array<{
    employeeId: number;
    employeeName: string;
    scheduledMinutes: number;
    allocationCount: number;
  }>;
  optimizerDiagnostics: PortfolioOptimizerDiagnostics;
  warnings: Array<{ code: string; message: string; projectId?: number; weekStart?: string }>;
  metrics: {
    proposedWorkMinutes: number;
    proposedFixedCoverageMinutes: number;
    regularMinutes: number;
    overtimeMinutes: number;
    regularCostCents: number;
    overtimeCostCents: number;
    retainedCostCents: number;
    fixedCoverageCostCents: number;
    workPackageCostCents: number;
    plannedCostCents: number;
    averagePlannedHourlyCostCents: number;
    assignedWorkPackages: number;
    unplannedWorkPackages: number;
    allocatedMinutes: number;
    fixedCoverageRequestedPositions: number;
    fixedCoverageAssignedPositions: number;
    unfilledFixedCoveragePositions: number;
    unfilledCriticalFixedCoveragePositions: number;
    criticalUnplannedWorkPackages: number;
  };
}

export interface AppliedPortfolioPlan {
  planningRunId: string;
  previewId: string;
  createdShifts: number;
  deletedShifts: number;
  metrics: PortfolioPlanPreview["metrics"];
}
