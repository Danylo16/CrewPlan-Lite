import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  allocatePortfolioScenarioPlans,
  allocatePortfolioWork,
} from "../src/planning/portfolioPlacementOptimizer.js";
import type {
  OptimizerEmployee,
  OptimizerProject,
  PlanningProfile,
  PortfolioOptimizerInput,
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
      algorithmVersion: "portfolio-pareto-beam-v1",
      strategy: "SHARED_MULTI_OBJECTIVE_PARETO_BEAM_SEARCH",
      beamWidth: 8,
      packageVariantWidth: 4,
      branchWidth: 4,
    });
    expect(costFirst.optimizerDiagnostics.evaluatedPlans).toBeGreaterThanOrEqual(2);
    expect(costFirst.optimizerDiagnostics.exploredStates).toBeLessThanOrEqual(4_500);
    expect(new Set([...plans.values()].map(
      (plan) => plan.optimizerDiagnostics.exploredStates,
    )).size).toBe(1);
  });
});
