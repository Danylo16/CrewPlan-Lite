import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  allocatePortfolioScenarioPlans,
  allocatePortfolioWork,
} from "../src/planning/portfolioPlacementOptimizer.js";
import {
  createObjectiveScoringContext,
  dependencyCyclePackageIds,
  objectiveComponents,
  type OptimizerEmployee,
  type OptimizerProject,
  type PlanningProfile,
  type PortfolioOptimizerInput,
} from "../src/planning/portfolioOptimizer.js";
import { SCHEDULE_TIME_ZONE } from "../src/scheduling/timeAdapter.js";

const fullWeek = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

function employee(
  id: number,
  name: string,
  hourlyCostCents: number,
  days = fullWeek,
  maxWeeklyMinutes = 2_400,
): OptimizerEmployee {
  return {
    id,
    name,
    hourlyCostCents,
    overtimeRateBasisPoints: 15_000,
    preferredWeeklyMinutes: maxWeeklyMinutes,
    maxWeeklyMinutes,
    skills: [{ skillId: 1, level: 5 }],
    availability: days.map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    })),
  };
}

function project(remainingMinutes: number, deadline: Date | null): OptimizerProject {
  return {
    id: 1,
    name: "Profile comparison",
    priority: "HIGH",
    optimizationStrategy: "BALANCED",
    startDate: new Date("2026-08-10T00:00:00.000Z"),
    targetEndDate: deadline,
    deadlineType: deadline === null ? "NONE" : "SOFT",
    totalLaborBudgetCents: null,
    weeklyLaborBudgetCents: null,
    workPackages: [{
      id: 10,
      name: "Delivery",
      remainingMinutes,
      requiredSkillId: 1,
      minimumSkillLevel: 3,
      maxParallelEmployees: 1,
      sortOrder: 0,
      earliestStartDate: null,
      targetEndDate: deadline,
      incomingDependencies: [],
    }],
  };
}

function input(
  planningProfile: PlanningProfile,
  employees: OptimizerEmployee[],
  portfolioProject: OptimizerProject,
): PortfolioOptimizerInput {
  return {
    start: DateTime.fromISO("2026-08-10", { zone: SCHEDULE_TIME_ZONE }),
    end: DateTime.fromISO("2026-08-17", { zone: SCHEDULE_TIME_ZONE }),
    employees,
    projects: [portfolioProject],
    occupiedIntervals: [],
    futurePlannedByPackage: new Map(),
    futurePlannedIntervalsByPackage: new Map(),
    planningProfile,
  };
}

describe("portfolio planning profiles", () => {
  it("makes the cost/deadline trade-off explicit", () => {
    const employees = [
      employee(1, "Available before deadline", 8_000, ["MONDAY"]),
      employee(2, "Cheaper after deadline", 4_000, ["TUESDAY"]),
    ];
    const portfolioProject = project(480, new Date("2026-08-10T00:00:00.000Z"));

    const costFirst = allocatePortfolioWork(input("COST_FIRST", employees, portfolioProject));
    const deadlineFirst = allocatePortfolioWork(
      input("DEADLINE_FIRST", employees, portfolioProject),
    );

    expect(costFirst.assignments[0]?.employeeId).toBe(2);
    expect(costFirst.optimizerDiagnostics.objectiveVector.softDeadlineExposureMinutes)
      .toBe(480);
    expect(deadlineFirst.assignments[0]?.employeeId).toBe(1);
    expect(deadlineFirst.optimizerDiagnostics.objectiveVector.softDeadlineExposureMinutes)
      .toBe(0);
    expect(costFirst.optimizerDiagnostics.optimized.laborCostCents)
      .toBeLessThan(deadlineFirst.optimizerDiagnostics.optimized.laborCostCents);
  });

  it("uses resilience-first to reduce skill concentration", () => {
    const employees = [
      employee(1, "Cheap primary", 3_000, fullWeek, 960),
      employee(2, "Backup A", 5_000, fullWeek, 480),
      employee(3, "Backup B", 5_000, fullWeek, 480),
    ];
    const portfolioProject = project(960, null);

    const costFirst = allocatePortfolioWork(input("COST_FIRST", employees, portfolioProject));
    const resilienceFirst = allocatePortfolioWork(
      input("RESILIENCE_FIRST", employees, portfolioProject),
    );

    expect(new Set(costFirst.assignments.map((assignment) => assignment.employeeId)).size)
      .toBe(1);
    expect(new Set(resilienceFirst.assignments.map((assignment) => assignment.employeeId)).size)
      .toBeGreaterThan(1);
    expect(resilienceFirst.optimizerDiagnostics.objectiveVector.skillConcentrationBasisPoints)
      .toBeLessThan(
        costFirst.optimizerDiagnostics.objectiveVector.skillConcentrationBasisPoints,
      );
    expect(costFirst.optimizerDiagnostics.optimized.laborCostCents)
      .toBeLessThan(resilienceFirst.optimizerDiagnostics.optimized.laborCostCents);
  });

  it("defaults existing callers to the balanced profile", () => {
    const result = allocatePortfolioWork({
      ...input("BALANCED", [employee(1, "Anna", 5_000)], project(480, null)),
      planningProfile: undefined,
    });

    expect(result.optimizerDiagnostics.planningProfile).toBe("BALANCED");
    expect(result.optimizerDiagnostics.objectiveVector).toMatchObject({
      criticalUnplannedMinutes: 0,
      hardDeadlineExposureMinutes: 0,
      singlePointExposureMinutes: 480,
    });
  });

  it("uses a smaller deterministic search budget for scenario shortlists", () => {
    const baseInput = input(
      "BALANCED",
      [employee(1, "Anna", 5_000), employee(2, "Backup", 5_500)],
      project(960, null),
    );
    const full = allocatePortfolioWork(baseInput);
    const comparison = allocatePortfolioWork({
      ...baseInput,
      searchMode: "COMPARISON",
    });

    expect(full.optimizerDiagnostics).toMatchObject({
      searchMode: "FULL",
      beamWidth: 6,
      packageVariantWidth: 3,
      branchWidth: 3,
    });
    expect(comparison.optimizerDiagnostics).toMatchObject({
      searchMode: "COMPARISON",
      beamWidth: 3,
      packageVariantWidth: 2,
      branchWidth: 2,
    });
    expect(comparison.optimizerDiagnostics.optimized.plannedMinutes).toBe(960);
  });

  it("selects profile trade-offs from one shared Pareto candidate pool", () => {
    const employees = [
      employee(1, "Available before deadline", 8_000, ["MONDAY"]),
      employee(2, "Cheaper after deadline", 4_000, ["TUESDAY"]),
    ];
    const portfolioProject = project(480, new Date("2026-08-10T00:00:00.000Z"));
    const plans = allocatePortfolioScenarioPlans(
      input("BALANCED", employees, portfolioProject),
      ["BALANCED", "COST_FIRST", "DEADLINE_FIRST", "RESILIENCE_FIRST"],
    );
    const costFirst = plans.get("COST_FIRST")!;
    const deadlineFirst = plans.get("DEADLINE_FIRST")!;

    expect(costFirst.assignments[0]?.employeeId).toBe(2);
    expect(deadlineFirst.assignments[0]?.employeeId).toBe(1);
    expect(costFirst.optimizerDiagnostics.optimized.laborCostCents)
      .toBeLessThan(deadlineFirst.optimizerDiagnostics.optimized.laborCostCents);
    expect(costFirst.optimizerDiagnostics).toMatchObject({
      algorithmVersion: "portfolio-pareto-beam-v4",
      strategy: "INDEXED_SHARED_MULTI_OBJECTIVE_PARETO_BEAM_SEARCH",
      beamWidth: 8,
      packageVariantWidth: 4,
      branchWidth: 4,
      placementStateLimit: 3_000,
    });
    expect(costFirst.optimizerDiagnostics.evaluatedPlans).toBeGreaterThanOrEqual(2);
    expect(costFirst.optimizerDiagnostics.exploredStates).toBeLessThanOrEqual(4_500);
    expect(new Set([...plans.values()].map(
      (plan) => plan.optimizerDiagnostics.exploredStates,
    )).size).toBe(1);
  });

  it("scores weekly and total budget overrun from actual and committed baselines", () => {
    const portfolioProject = {
      ...project(480, null),
      totalLaborBudgetCents: 50_000,
      weeklyLaborBudgetCents: 20_000,
    };
    const portfolioInput = {
      ...input("COST_FIRST", [employee(1, "Anna", 3_750)], portfolioProject),
      budgetBaselineByProject: new Map([[1, {
        actualCostCents: 40_000,
        committedCostCents: 10_000,
        committedWeeklyCostCents: new Map([["2026-08-10", 15_000]]),
      }]]),
    };
    const result = allocatePortfolioWork(portfolioInput);
    expect(result.optimizerDiagnostics.objectiveVector).toMatchObject({
      weeklyBudgetOverrunCents: 25_000,
      totalBudgetOverrunCents: 30_000,
    });
  });

  it("reports only Work Packages that participate in a dependency cycle", () => {
    const first = project(480, null);
    first.workPackages.push({
      ...first.workPackages[0]!,
      id: 11,
      name: "Successor",
      incomingDependencies: [{
        predecessorId: 10,
        lagMinutes: 0,
        predecessor: { status: "TODO", name: "Delivery" },
      }],
    });
    first.workPackages[0]!.incomingDependencies = [{
      predecessorId: 11,
      lagMinutes: 0,
      predecessor: { status: "TODO", name: "Successor" },
    }];
    first.workPackages.push({
      ...first.workPackages[0]!,
      id: 12,
      name: "Independent",
      incomingDependencies: [],
    });
    expect(dependencyCyclePackageIds([first])).toEqual([10, 11]);
  });

  it("keeps later cheap capacity visible across availability gaps", () => {
    const employees = [
      employee(1, "Expensive before deadline", 6_500, ["MONDAY", "TUESDAY"]),
      employee(2, "Cheap after deadline", 3_800, ["THURSDAY", "FRIDAY"]),
    ];
    const portfolioProject = project(480, new Date("2026-08-11T00:00:00.000Z"));
    const plans = allocatePortfolioScenarioPlans(
      input("BALANCED", employees, portfolioProject),
      ["BALANCED", "COST_FIRST", "DEADLINE_FIRST", "RESILIENCE_FIRST"],
    );
    const costFirst = plans.get("COST_FIRST")!;
    const deadlineFirst = plans.get("DEADLINE_FIRST")!;

    expect(costFirst.assignments[0]?.employeeId).toBe(2);
    expect(costFirst.optimizerDiagnostics.optimized.laborCostCents).toBe(30_400);
    expect(costFirst.optimizerDiagnostics.objectiveVector.softDeadlineExposureMinutes)
      .toBe(480);
    expect(deadlineFirst.assignments[0]?.employeeId).toBe(1);
    expect(deadlineFirst.optimizerDiagnostics.optimized.laborCostCents).toBe(52_000);
    expect(deadlineFirst.optimizerDiagnostics.objectiveVector.softDeadlineExposureMinutes)
      .toBe(0);
  });

  it("reuses static objective indexes without changing plan scoring", () => {
    const portfolioInput = input(
      "RESILIENCE_FIRST",
      [
        employee(1, "Primary", 4_000, fullWeek, 960),
        employee(2, "Backup", 5_000, fullWeek, 480),
      ],
      project(960, null),
    );
    const result = allocatePortfolioWork(portfolioInput);
    const plan = {
      assignments: result.assignments,
      unplannedWorkPackages: result.unplannedWorkPackages,
    };

    expect(objectiveComponents(
      plan,
      portfolioInput,
      true,
      createObjectiveScoringContext(portfolioInput),
    )).toEqual(objectiveComponents(plan, portfolioInput));
  });

  it("does not compute resilience dimensions for comparisons that do not request them", () => {
    const plans = allocatePortfolioScenarioPlans(
      input(
        "BALANCED",
        [
          employee(1, "Early", 8_000, ["MONDAY"]),
          employee(2, "Cheap", 4_000, ["TUESDAY"]),
        ],
        project(480, new Date("2026-08-10T00:00:00.000Z")),
      ),
      ["COST_FIRST", "DEADLINE_FIRST"],
    );

    expect(plans.get("COST_FIRST")!.optimizerDiagnostics.objectiveVector)
      .toMatchObject({
        singlePointExposureMinutes: 0,
        maxRecoveryShortfallMinutes: 0,
        skillConcentrationBasisPoints: 0,
      });
    expect(plans.get("COST_FIRST")!.assignments[0]?.employeeId).toBe(2);
    expect(plans.get("DEADLINE_FIRST")!.assignments[0]?.employeeId).toBe(1);
  });
});
