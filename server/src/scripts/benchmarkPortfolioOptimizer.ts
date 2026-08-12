import { performance } from "node:perf_hooks";
import { DateTime } from "luxon";
import {
  allocatePortfolioWorkGreedy,
  allocatePortfolioWorkV1,
  compareVectors,
  objectiveVector,
  resultMetrics,
  type OptimizerEmployee,
  type OptimizerProject,
  type OptimizerWorkPackage,
  type PortfolioOptimizerInput,
} from "../planning/portfolioOptimizer.js";
import { allocatePortfolioWork } from "../planning/portfolioPlacementOptimizer.js";
import { SCHEDULE_TIME_ZONE } from "../scheduling/timeAdapter.js";

interface BenchmarkScenario {
  name: string;
  description: string;
  input: PortfolioOptimizerInput;
}

const weekDays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

function employee(
  id: number,
  name: string,
  skillIds: number[],
  overrides: Partial<OptimizerEmployee> = {},
): OptimizerEmployee {
  return {
    id,
    name,
    hourlyCostCents: 5_000,
    overtimeRateBasisPoints: 15_000,
    preferredWeeklyMinutes: 2_400,
    maxWeeklyMinutes: 2_400,
    skills: skillIds.map((skillId) => ({ skillId, level: 5 })),
    availability: weekDays.map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    })),
    ...overrides,
  };
}

function workPackage(
  id: number,
  name: string,
  requiredSkillId: number,
  overrides: Partial<OptimizerWorkPackage> = {},
): OptimizerWorkPackage {
  return {
    id,
    name,
    remainingMinutes: 480,
    requiredSkillId,
    minimumSkillLevel: 3,
    maxParallelEmployees: 1,
    sortOrder: id,
    earliestStartDate: null,
    targetEndDate: null,
    incomingDependencies: [],
    ...overrides,
  };
}

function project(
  id: number,
  name: string,
  workPackages: OptimizerWorkPackage[],
  overrides: Partial<OptimizerProject> = {},
): OptimizerProject {
  return {
    id,
    name,
    priority: "NORMAL",
    optimizationStrategy: "BALANCED",
    startDate: new Date("2026-08-10T00:00:00.000Z"),
    targetEndDate: new Date("2026-08-31T00:00:00.000Z"),
    deadlineType: "SOFT",
    totalLaborBudgetCents: null,
    weeklyLaborBudgetCents: null,
    workPackages,
    ...overrides,
  };
}

function input(
  employees: OptimizerEmployee[],
  projects: OptimizerProject[],
  occupiedIntervals: PortfolioOptimizerInput["occupiedIntervals"] = [],
): PortfolioOptimizerInput {
  return {
    start: DateTime.fromISO("2026-08-10", { zone: SCHEDULE_TIME_ZONE }),
    end: DateTime.fromISO("2026-08-17", { zone: SCHEDULE_TIME_ZONE }),
    employees,
    projects,
    occupiedIntervals,
    futurePlannedByPackage: new Map(),
    futurePlannedIntervalsByPackage: new Map(),
  };
}

function scenarios(): BenchmarkScenario[] {
  const flexible = workPackage(10, "React delivery", 1, { sortOrder: 0 });
  const scarce = workPackage(11, "DevOps delivery", 2, { sortOrder: 1 });
  const forcedScarce = workPackage(21, "Production deployment", 2, {
    sortOrder: 1,
    incomingDependencies: [{
      predecessorId: 20,
      lagMinutes: 0,
      predecessor: { status: "TODO", name: "Architecture groundwork" },
    }],
  });

  return [
    {
      name: "scarce_skill_reordering",
      description: "Preserve the only DevOps-capable employee by changing package order.",
      input: input(
        [
          employee(1, "Anna multi-skilled", [1, 2], {
            preferredWeeklyMinutes: 480,
            maxWeeklyMinutes: 480,
          }),
          employee(2, "Marko React-only", [1], {
            preferredWeeklyMinutes: 480,
            maxWeeklyMinutes: 480,
          }),
        ],
        [project(1, "Scarcity portfolio", [flexible, scarce])],
      ),
    },
    {
      name: "forced_dependency_placement",
      description: "Dependencies fix package order, so the optimizer must branch by employee.",
      input: input(
        [
          employee(1, "Anna multi-skilled", [1, 2], {
            preferredWeeklyMinutes: 480,
            maxWeeklyMinutes: 480,
          }),
          employee(2, "Marko React-only", [1], {
            preferredWeeklyMinutes: 480,
            maxWeeklyMinutes: 480,
          }),
        ],
        [project(2, "Forced-order portfolio", [
          workPackage(20, "Architecture groundwork", 1, { sortOrder: 0 }),
          forcedScarce,
        ])],
      ),
    },
    {
      name: "equivalent_coverage_cost",
      description: "Equivalent coverage must use the lower regular labor cost.",
      input: input(
        [
          employee(1, "Expensive", [1], { hourlyCostCents: 8_000 }),
          employee(2, "Efficient", [1], { hourlyCostCents: 4_000 }),
        ],
        [project(3, "Cost portfolio", [workPackage(30, "API delivery", 1)], {
          optimizationStrategy: "MINIMIZE_COST",
        })],
      ),
    },
    {
      name: "regular_capacity_before_overtime",
      description: "Cheaper overtime must not displace available regular capacity.",
      input: input(
        [
          employee(1, "Cheap overtime", [1], {
            hourlyCostCents: 2_000,
            preferredWeeklyMinutes: 0,
            maxWeeklyMinutes: 480,
          }),
          employee(2, "Regular capacity", [1], {
            hourlyCostCents: 4_000,
            preferredWeeklyMinutes: 480,
            maxWeeklyMinutes: 480,
          }),
        ],
        [project(4, "Overtime portfolio", [workPackage(40, "Release", 1)], {
          optimizationStrategy: "MINIMIZE_COST",
        })],
      ),
    },
    {
      name: "mixed_portfolio_scale",
      description: "Mixed skills, priorities, dependencies and deadlines under bounded search.",
      input: input(
        [
          employee(1, "Full-stack", [1, 2], { hourlyCostCents: 6_000 }),
          employee(2, "Frontend", [1], { hourlyCostCents: 4_000 }),
          employee(3, "Backend", [2], { hourlyCostCents: 4_500 }),
          employee(4, "Platform", [2, 3], {
            hourlyCostCents: 5_500,
            preferredWeeklyMinutes: 1_800,
            maxWeeklyMinutes: 2_400,
          }),
          employee(5, "DevOps", [3], { hourlyCostCents: 4_200 }),
        ],
        [
          project(5, "Critical launch", [
            workPackage(50, "Infrastructure", 3, {
              remainingMinutes: 960,
              targetEndDate: new Date("2026-08-12T00:00:00.000Z"),
            }),
            workPackage(51, "Backend", 2, { remainingMinutes: 960 }),
          ], { priority: "CRITICAL", deadlineType: "HARD" }),
          project(6, "Customer portal", [
            workPackage(60, "Frontend", 1, { remainingMinutes: 1_440 }),
            workPackage(61, "API", 2, { remainingMinutes: 960 }),
            workPackage(62, "Delivery pipeline", 3, { remainingMinutes: 480 }),
          ], { priority: "HIGH", optimizationStrategy: "MINIMIZE_COST" }),
          project(7, "Internal tooling", [
            workPackage(70, "Dashboard", 1, { remainingMinutes: 960 }),
          ], { priority: "LOW" }),
        ],
      ),
    },
  ];
}

function timed<T>(operation: () => T) {
  const startedAt = performance.now();
  const value = operation();
  return { value, runtimeMs: Math.round((performance.now() - startedAt) * 100) / 100 };
}

function assignmentSignature(result: { assignments: Array<{
  workPackageId: number;
  employeeId: number;
  startAt: Date;
  endAt: Date;
}> }) {
  return result.assignments.map((assignment) => [
    assignment.workPackageId,
    assignment.employeeId,
    assignment.startAt.toISOString(),
    assignment.endAt.toISOString(),
  ].join(":"))
    .sort()
    .join("|");
}

const report = scenarios().map((scenario) => {
  const greedy = timed(() => allocatePortfolioWorkGreedy(scenario.input));
  const v1 = timed(() => allocatePortfolioWorkV1(scenario.input));
  const v2 = timed(() => allocatePortfolioWork(scenario.input));
  const repeatedV2 = allocatePortfolioWork(scenario.input);
  const greedyVector = objectiveVector(greedy.value, scenario.input);
  const v1Vector = objectiveVector(v1.value, scenario.input);
  const v2Vector = objectiveVector(v2.value, scenario.input);
  if (compareVectors(v2Vector, greedyVector) > 0 || compareVectors(v2Vector, v1Vector) > 0) {
    throw new Error(`${scenario.name}: v2 regressed against a baseline`);
  }
  if (assignmentSignature(v2.value) !== assignmentSignature(repeatedV2)) {
    throw new Error(`${scenario.name}: v2 produced a non-deterministic plan`);
  }
  const greedyMetrics = resultMetrics(greedy.value);
  const v1Metrics = resultMetrics(v1.value);
  const v2Metrics = resultMetrics(v2.value);
  return {
    scenario: scenario.name,
    description: scenario.description,
    greedy: { ...greedyMetrics, runtimeMs: greedy.runtimeMs, objectiveVector: greedyVector },
    v1: { ...v1Metrics, runtimeMs: v1.runtimeMs, objectiveVector: v1Vector },
    v2: {
      ...v2Metrics,
      runtimeMs: v2.runtimeMs,
      objectiveVector: v2Vector,
      exploredStates: v2.value.optimizerDiagnostics.exploredStates,
      prunedStates: v2.value.optimizerDiagnostics.prunedStates,
      dominancePrunedStates: v2.value.optimizerDiagnostics.dominancePrunedStates,
      searchLimitReached: v2.value.optimizerDiagnostics.searchLimitReached,
    },
    improvement: {
      plannedMinutesVsGreedy: v2Metrics.plannedMinutes - greedyMetrics.plannedMinutes,
      plannedMinutesVsV1: v2Metrics.plannedMinutes - v1Metrics.plannedMinutes,
      unplannedMinutesVsGreedy: greedyMetrics.unplannedMinutes - v2Metrics.unplannedMinutes,
      laborCostCentsVsGreedy: greedyMetrics.laborCostCents - v2Metrics.laborCostCents,
    },
    deterministic: true,
  };
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.table(report.map((item) => ({
    scenario: item.scenario,
    greedyMin: item.greedy.plannedMinutes,
    v1Min: item.v1.plannedMinutes,
    v2Min: item.v2.plannedMinutes,
    v2Gain: item.improvement.plannedMinutesVsGreedy,
    greedyCost: item.greedy.laborCostCents,
    v2Cost: item.v2.laborCostCents,
    runtimeMs: item.v2.runtimeMs,
    states: item.v2.exploredStates,
    pruned: item.v2.prunedStates,
    limit: item.v2.searchLimitReached,
    deterministic: item.deterministic,
  })));
}
