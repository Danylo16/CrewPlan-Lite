import { describe, expect, it, vi } from "vitest";
import {
  buildPortfolioPlanPreview,
  buildPortfolioScenarioComparison,
} from "../src/planning/portfolioPlan.js";
import { allocatePortfolioWork } from "../src/planning/portfolioPlacementOptimizer.js";
import { buildPortfolioResilienceReport } from "../src/planning/portfolioResilience.js";
import { buildSchedulePreview } from "../src/scheduling/schedulePreview.js";

const mondayToFriday = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"].map((dayOfWeek, id) => ({
  id: id + 1,
  employeeId: 1,
  dayOfWeek,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
}));

function employee(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Anna",
    email: "anna@example.com",
    role: "Engineer",
    preferredWeeklyMinutes: 2_400,
    maxWeeklyMinutes: 2_400,
    hourlyCostCents: 6_000,
    overtimeRateBasisPoints: 15_000,
    archivedAt: null,
    archiveReason: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    skills: [{ employeeId: 1, skillId: 1, level: 5 }],
    availability: mondayToFriday,
    ...overrides,
  };
}

function workPackage(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    projectId: 1,
    name: "Build API",
    description: null,
    status: "TODO",
    requiredSkillId: 1,
    minimumSkillLevel: 3,
    estimatedMinutes: 480,
    remainingMinutes: 480,
    maxParallelEmployees: 1,
    earliestStartDate: null,
    targetEndDate: null,
    sortOrder: 0,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    incomingDependencies: [],
    ...overrides,
  };
}

function project(packages = [workPackage()], overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Payments",
    color: "#2563EB",
    status: "ACTIVE",
    startDate: new Date("2026-08-10T00:00:00.000Z"),
    targetEndDate: new Date("2026-09-30T00:00:00.000Z"),
    completedAt: null,
    archivedAt: null,
    deadlineType: "SOFT",
    priority: "HIGH",
    optimizationStrategy: "BALANCED",
    totalLaborBudgetCents: 1_000_000,
    weeklyLaborBudgetCents: 500_000,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    workLogs: [],
    workPackages: packages,
    ...overrides,
  };
}

function database(
  projects: ReturnType<typeof project>[],
  shifts: Array<Record<string, unknown>> = [],
  employees = [employee()],
) {
  return {
    employee: { findMany: vi.fn().mockImplementation(({ where }) => {
      const excluded = new Set<number>(where?.id?.notIn ?? []);
      return Promise.resolve(employees.filter((item) => !excluded.has(item.id)));
    }) },
    projectRequirement: { findMany: vi.fn().mockResolvedValue([]) },
    project: { findMany: vi.fn().mockResolvedValue(projects) },
    shift: {
      findMany: vi.fn().mockImplementation(({ where }) => Promise.resolve(
        where.kind === "WORK_PACKAGE"
          ? shifts.filter((shift) => shift.kind === "WORK_PACKAGE")
          : shifts,
      )),
    },
  } as never;
}

describe("multi-week portfolio planner", () => {
  it("compares all profiles against one memoized database snapshot", async () => {
    const planningDatabase = database([project()]);
    const fixedPreviewRunner = vi.fn(buildSchedulePreview);
    const comparison = await buildPortfolioScenarioComparison(planningDatabase, {
      horizonStart: "2026-08-10",
      horizonWeeks: 1,
      replaceGenerated: true,
      fixedPreviewRunner,
    });

    expect(comparison.scenarios.map((scenario) => scenario.planningProfile)).toEqual([
      "BALANCED",
      "COST_FIRST",
      "DEADLINE_FIRST",
      "RESILIENCE_FIRST",
    ]);
    expect(comparison.scenarios.every((scenario) => scenario.proposedWorkMinutes === 480)).toBe(true);
    expect(comparison.scenarios.every(
      (scenario) => scenario.algorithmVersion === "portfolio-pareto-beam-v4",
    )).toBe(true);
    expect(comparison.comparisonMode).toBe("SHARED_PARETO_FRONTIER");
    expect(new Set(comparison.scenarios.map(
      (scenario) => scenario.optimizerRuntimeMs,
    )).size).toBe(1);
    expect(comparison.scenarios.every((scenario) => scenario.exploredStates > 0)).toBe(true);
    expect(comparison.scenarios.every((scenario) => scenario.candidateCount >= 1)).toBe(true);
    expect(comparison.scenarios.every(
      (scenario) => scenario.exploredStates
        === scenario.orderExploredStates + scenario.placementExploredStates,
    )).toBe(true);
    expect(planningDatabase.employee.findMany).toHaveBeenCalledTimes(2);
    expect(planningDatabase.project.findMany).toHaveBeenCalledTimes(1);
    expect(planningDatabase.projectRequirement.findMany).toHaveBeenCalledTimes(1);
    expect(planningDatabase.shift.findMany).toHaveBeenCalledTimes(2);
    expect(fixedPreviewRunner).toHaveBeenCalledTimes(1);
  });

  it("loads fixed coverage once for a multi-week comparison", async () => {
    const planningDatabase = database([project()]);
    const comparison = await buildPortfolioScenarioComparison(planningDatabase, {
      horizonStart: "2026-08-10",
      horizonWeeks: 6,
      replaceGenerated: true,
    });

    expect(comparison.scenarios).toHaveLength(4);
    expect(planningDatabase.employee.findMany).toHaveBeenCalledTimes(2);
    expect(planningDatabase.project.findMany).toHaveBeenCalledTimes(1);
    expect(planningDatabase.projectRequirement.findMany).toHaveBeenCalledTimes(1);
    expect(planningDatabase.shift.findMany).toHaveBeenCalledTimes(2);
  });

  it("fully recovers a scheduled employee absence when an equivalent replacement exists", async () => {
    const planningDatabase = database(
      [project()],
      [],
      [
        employee({ id: 1, name: "Primary", hourlyCostCents: 4_000 }),
        employee({ id: 2, name: "Replacement", hourlyCostCents: 5_000 }),
      ],
    );
    const options = {
      horizonStart: "2026-08-10",
      horizonWeeks: 1,
      replaceGenerated: true,
    };
    const preview = await buildPortfolioPlanPreview(planningDatabase, options);
    const report = await buildPortfolioResilienceReport(planningDatabase, {
      ...options,
      previewId: preview.previewId,
      inputVersion: preview.inputVersion,
    });

    expect(report).toMatchObject({
      scorePercent: 100,
      worstCaseCoveragePercent: 100,
      testedAbsences: 1,
      recoverableAbsences: 1,
      employeesWithNoFullReplacement: [],
    });
    expect(report.scenarios[0]).toMatchObject({
      employeeName: "Primary",
      lostMinutes: 0,
      recoverable: true,
      additionalCostCents: 8_000,
      reassignedAllocations: 1,
      rescheduledAllocations: 0,
    });
  });

  it("locally reschedules affected work when no same-slot replacement exists", async () => {
    const planningDatabase = database(
      [project()],
      [],
      [
        employee({
          id: 1,
          name: "Monday primary",
          hourlyCostCents: 4_000,
          availability: [{
            id: 1,
            employeeId: 1,
            dayOfWeek: "MONDAY",
            startMinute: 9 * 60,
            endMinute: 17 * 60,
          }],
        }),
        employee({
          id: 2,
          name: "Tuesday replacement",
          hourlyCostCents: 5_000,
          availability: [{
            id: 2,
            employeeId: 2,
            dayOfWeek: "TUESDAY",
            startMinute: 9 * 60,
            endMinute: 17 * 60,
          }],
          skills: [{ employeeId: 2, skillId: 1, level: 5 }],
        }),
      ],
    );
    const options = {
      horizonStart: "2026-08-10",
      horizonWeeks: 1,
      replaceGenerated: true,
    };
    const preview = await buildPortfolioPlanPreview(planningDatabase, options);
    expect(preview.assignments[0]).toMatchObject({ employeeId: 1 });

    const report = await buildPortfolioResilienceReport(planningDatabase, {
      ...options,
      previewId: preview.previewId,
      inputVersion: preview.inputVersion,
    });

    expect(report).toMatchObject({ testedAbsences: 1, recoverableAbsences: 1 });
    expect(report.scenarios[0]).toMatchObject({
      employeeName: "Monday primary",
      lostMinutes: 0,
      recoverable: true,
      reassignedAllocations: 1,
      rescheduledAllocations: 1,
      displacementMinutes: 1_440,
    });
  });

  it("recovers an absence through a bounded two-step allocation chain", async () => {
    const apiPackage = workPackage({
      id: 10,
      name: "API delivery",
      requiredSkillId: 1,
      sortOrder: 0,
    });
    const opsPackage = workPackage({
      id: 11,
      name: "Operations delivery",
      requiredSkillId: 2,
      sortOrder: 1,
    });
    const monday = [{
      id: 1,
      employeeId: 1,
      dayOfWeek: "MONDAY",
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    }];
    const tuesday = [{
      id: 3,
      employeeId: 3,
      dayOfWeek: "TUESDAY",
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    }];
    const planningDatabase = database(
      [project([apiPackage, opsPackage])],
      [],
      [
        employee({
          id: 1,
          name: "API primary",
          preferredWeeklyMinutes: 480,
          maxWeeklyMinutes: 480,
          hourlyCostCents: 4_000,
          availability: monday,
          skills: [{ employeeId: 1, skillId: 1, level: 5 }],
        }),
        employee({
          id: 2,
          name: "Multi-skilled blocker",
          preferredWeeklyMinutes: 480,
          maxWeeklyMinutes: 480,
          hourlyCostCents: 5_000,
          availability: monday.map((item) => ({ ...item, id: 2, employeeId: 2 })),
          skills: [
            { employeeId: 2, skillId: 1, level: 5 },
            { employeeId: 2, skillId: 2, level: 5 },
          ],
        }),
        employee({
          id: 3,
          name: "Tuesday ops replacement",
          preferredWeeklyMinutes: 480,
          maxWeeklyMinutes: 480,
          hourlyCostCents: 6_000,
          availability: tuesday,
          skills: [{ employeeId: 3, skillId: 2, level: 5 }],
        }),
      ],
    );
    const options = {
      horizonStart: "2026-08-10",
      horizonWeeks: 1,
      replaceGenerated: true,
    };
    const preview = await buildPortfolioPlanPreview(planningDatabase, options);
    expect(preview.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ workPackageId: 10, employeeId: 1 }),
      expect.objectContaining({ workPackageId: 11, employeeId: 2 }),
    ]));

    const report = await buildPortfolioResilienceReport(planningDatabase, {
      ...options,
      previewId: preview.previewId,
      inputVersion: preview.inputVersion,
    });
    const primaryAbsence = report.scenarios.find(
      (scenario) => scenario.employeeName === "API primary",
    );

    expect(primaryAbsence).toMatchObject({
      lostMinutes: 0,
      recoverable: true,
      reassignedAllocations: 2,
      rescheduledAllocations: 1,
      ejectedAllocations: 1,
    });
  });

  it("identifies a scheduled employee with no replacement", async () => {
    const planningDatabase = database([project()]);
    const options = {
      horizonStart: "2026-08-10",
      horizonWeeks: 1,
      replaceGenerated: true,
    };
    const preview = await buildPortfolioPlanPreview(planningDatabase, options);
    const report = await buildPortfolioResilienceReport(planningDatabase, {
      ...options,
      previewId: preview.previewId,
      inputVersion: preview.inputVersion,
    });

    expect(report).toMatchObject({
      scorePercent: 0,
      worstCaseCoveragePercent: 0,
      testedAbsences: 1,
      recoverableAbsences: 0,
      worstCaseEmployee: "Anna",
      employeesWithNoFullReplacement: ["Anna"],
    });
    expect(report.scenarios[0]).toMatchObject({
      affectedMinutes: 480,
      lostMinutes: 480,
      recoverable: false,
    });
  });

  it("tests every scheduled employee beyond the former 12-scenario cap", async () => {
    const employees = Array.from({ length: 13 }, (_, index) => employee({
      id: index + 1,
      name: `Employee ${index + 1}`,
      email: `employee-${index + 1}@example.com`,
      preferredWeeklyMinutes: 240,
      maxWeeklyMinutes: 240,
      availability: mondayToFriday.map((availability) => ({
        ...availability,
        id: availability.id + index * mondayToFriday.length,
        employeeId: index + 1,
      })),
      skills: [{ employeeId: index + 1, skillId: 1, level: 5 }],
    }));
    const shifts = employees.map((item, index) => ({
      id: 1_000 + index,
      employeeId: item.id,
      projectId: 1,
      workPackageId: null,
      projectRequirementId: null,
      planningRunId: null,
      startAt: new Date("2026-08-10T07:00:00.000Z"),
      endAt: new Date("2026-08-10T11:00:00.000Z"),
      note: null,
      kind: "GENERAL",
      origin: "MANUAL",
      status: "COMMITTED",
      plannedCostCents: null,
      cancelledAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    }));
    const planningDatabase = database([project([])], shifts, employees);
    const options = {
      horizonStart: "2026-08-10",
      horizonWeeks: 1,
      replaceGenerated: true,
    };
    const preview = await buildPortfolioPlanPreview(planningDatabase, options);
    const optimizerRunner = vi.fn(allocatePortfolioWork);
    const report = await buildPortfolioResilienceReport(planningDatabase, {
      ...options,
      previewId: preview.previewId,
      inputVersion: preview.inputVersion,
      optimizerRunner,
    });

    expect(report.algorithmVersion).toBe("portfolio-resilience-n-minus-one-v7");
    expect(report.testedAbsences).toBe(13);
    expect(report.scenarios).toHaveLength(13);
    expect(optimizerRunner).toHaveBeenCalledTimes(1);
    expect(planningDatabase.employee.findMany).toHaveBeenCalledTimes(4);
    expect(planningDatabase.project.findMany).toHaveBeenCalledTimes(2);
    expect(planningDatabase.projectRequirement.findMany).toHaveBeenCalledTimes(2);
    expect(planningDatabase.shift.findMany).toHaveBeenCalledTimes(5);
  });

  it("allocates remaining scope without changing actual progress", async () => {
    const preview = await buildPortfolioPlanPreview(database([project()]), {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });

    expect(preview.metrics.proposedWorkMinutes).toBe(480);
    expect(preview.assignments).toHaveLength(1);
    expect(preview.assignments.every((item) => item.workPackageId === 10)).toBe(true);
    expect(preview.unplannedWorkPackages).toEqual([]);
    expect(preview.metrics.plannedCostCents).toBe(48_000);
  });

  it("preserves scarce multi-skilled capacity with bounded beam search", async () => {
    const reactPackage = workPackage({
      id: 10,
      name: "React delivery",
      requiredSkillId: 1,
      sortOrder: 0,
    });
    const devOpsPackage = workPackage({
      id: 11,
      name: "DevOps delivery",
      requiredSkillId: 2,
      sortOrder: 1,
    });
    const preview = await buildPortfolioPlanPreview(database(
      [project([reactPackage, devOpsPackage])],
      [],
      [
        employee({
          id: 1,
          name: "Anna multi-skilled",
          preferredWeeklyMinutes: 480,
          maxWeeklyMinutes: 480,
          skills: [
            { employeeId: 1, skillId: 1, level: 5 },
            { employeeId: 1, skillId: 2, level: 5 },
          ],
        }),
        employee({
          id: 2,
          name: "Marko React-only",
          preferredWeeklyMinutes: 480,
          maxWeeklyMinutes: 480,
          skills: [{ employeeId: 2, skillId: 1, level: 5 }],
        }),
      ],
    ), {
      horizonStart: "2026-08-10",
      horizonWeeks: 1,
      replaceGenerated: true,
    });

    expect(preview.metrics.proposedWorkMinutes).toBe(960);
    expect(preview.unplannedWorkPackages).toEqual([]);
    expect(preview.assignments.find((item) => item.workPackageId === 10)?.employeeId).toBe(2);
    expect(preview.assignments.find((item) => item.workPackageId === 11)?.employeeId).toBe(1);
    expect(preview.optimizerDiagnostics.strategy)
      .toBe("PLACEMENT_AWARE_BOUNDED_BEAM_SEARCH");
    expect(preview.optimizerDiagnostics.greedyBaseline.plannedMinutes).toBe(480);
    expect(preview.optimizerDiagnostics.optimized.plannedMinutes).toBe(960);
    expect(preview.optimizerDiagnostics.improvement.plannedMinutes).toBe(480);
    expect(preview.optimizerDiagnostics.exploredStates).toBeGreaterThan(0);
  });

  it("branches on employee placement when dependencies force package order", async () => {
    const reactPackage = workPackage({
      id: 10,
      name: "Architecture groundwork",
      requiredSkillId: 1,
      sortOrder: 0,
    });
    const devOpsPackage = workPackage({
      id: 11,
      name: "Production deployment",
      requiredSkillId: 2,
      sortOrder: 1,
      incomingDependencies: [{
        predecessorId: 10,
        successorId: 11,
        lagMinutes: 0,
        predecessor: {
          id: 10,
          name: "Architecture groundwork",
          status: "TODO",
        },
      }],
    });
    const preview = await buildPortfolioPlanPreview(database(
      [project([reactPackage, devOpsPackage])],
      [],
      [
        employee({
          id: 1,
          name: "Anna multi-skilled",
          preferredWeeklyMinutes: 480,
          maxWeeklyMinutes: 480,
          skills: [
            { employeeId: 1, skillId: 1, level: 5 },
            { employeeId: 1, skillId: 2, level: 5 },
          ],
        }),
        employee({
          id: 2,
          name: "Marko React-only",
          preferredWeeklyMinutes: 480,
          maxWeeklyMinutes: 480,
          skills: [{ employeeId: 2, skillId: 1, level: 5 }],
        }),
      ],
    ), {
      horizonStart: "2026-08-10",
      horizonWeeks: 1,
      replaceGenerated: true,
    });

    expect(preview.metrics.proposedWorkMinutes).toBe(960);
    expect(preview.unplannedWorkPackages).toEqual([]);
    expect(preview.assignments.find((item) => item.workPackageId === 10)?.employeeId).toBe(2);
    expect(preview.assignments.find((item) => item.workPackageId === 11)?.employeeId).toBe(1);
    expect(preview.optimizerDiagnostics.algorithmVersion).toBe("portfolio-beam-v3");
    expect(preview.optimizerDiagnostics.v1Baseline.plannedMinutes).toBe(480);
    expect(preview.optimizerDiagnostics.optimized.plannedMinutes).toBe(960);
    expect(preview.optimizerDiagnostics.improvementVsV1.plannedMinutes).toBe(480);
  });

  it("produces a deterministic plan across repeated beam searches", async () => {
    const planningDatabase = database([project()]);
    const options = {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    };

    const first = await buildPortfolioPlanPreview(planningDatabase, options);
    const second = await buildPortfolioPlanPreview(planningDatabase, options);

    expect(second.previewId).toBe(first.previewId);
    expect(second.assignments).toEqual(first.assignments);
    expect(second.unplannedWorkPackages).toEqual(first.unplannedWorkPackages);
    expect(second.optimizerDiagnostics.objectiveVector)
      .toEqual(first.optimizerDiagnostics.objectiveVector);
  });

  it("selects lower regular labor cost when coverage is equivalent", async () => {
    const preview = await buildPortfolioPlanPreview(database(
      [project(undefined, { optimizationStrategy: "MINIMIZE_COST" })],
      [],
      [
        employee({ id: 1, name: "Expensive", hourlyCostCents: 8_000 }),
        employee({ id: 2, name: "Efficient", hourlyCostCents: 4_000 }),
      ],
    ), {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });

    expect(preview.assignments[0]?.employeeId).toBe(2);
    expect(preview.metrics.workPackageCostCents).toBe(32_000);
    expect(preview.metrics.overtimeMinutes).toBe(0);
  });

  it("prefers regular capacity over cheaper overtime", async () => {
    const preview = await buildPortfolioPlanPreview(database(
      [project(undefined, { optimizationStrategy: "MINIMIZE_COST" })],
      [],
      [
        employee({
          id: 1,
          name: "Cheap overtime",
          hourlyCostCents: 2_000,
          preferredWeeklyMinutes: 0,
        }),
        employee({ id: 2, name: "Regular capacity", hourlyCostCents: 4_000 }),
      ],
    ), {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });

    expect(preview.assignments[0]?.employeeId).toBe(2);
    expect(preview.metrics.overtimeMinutes).toBe(0);
  });

  it("includes retained commitments and exposes signed budget variance", async () => {
    const retainedAllocation = {
      id: 102,
      employeeId: 1,
      projectId: 1,
      workPackageId: null,
      projectRequirementId: null,
      planningRunId: null,
      startAt: new Date("2026-08-10T07:00:00.000Z"),
      endAt: new Date("2026-08-10T11:00:00.000Z"),
      note: null,
      kind: "GENERAL",
      origin: "MANUAL",
      status: "COMMITTED",
      plannedCostCents: null,
      cancelledAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const preview = await buildPortfolioPlanPreview(database(
      [project(undefined, {
        totalLaborBudgetCents: 100_000,
        weeklyLaborBudgetCents: 50_000,
      })],
      [retainedAllocation],
      [employee({ preferredWeeklyMinutes: 480 })],
    ), {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });

    expect(preview.metrics).toMatchObject({
      regularMinutes: 480,
      overtimeMinutes: 240,
      regularCostCents: 48_000,
      overtimeCostCents: 36_000,
      retainedCostCents: 24_000,
      workPackageCostCents: 60_000,
      plannedCostCents: 84_000,
    });
    expect(preview.projectCostSummaries[0]).toMatchObject({
      knownCostCents: 84_000,
      totalBudgetVarianceCents: -16_000,
      forecastComplete: true,
    });
    expect(preview.projectCostSummaries[0]?.weeks[0]).toMatchObject({
      plannedCostCents: 84_000,
      weeklyBudgetVarianceCents: 34_000,
    });
  });

  it("includes Fixed Coverage labor in weekly and total budget evidence", async () => {
    const planningDatabase = database([project([], {
      totalLaborBudgetCents: 100_000,
      weeklyLaborBudgetCents: 50_000,
    })]);
    planningDatabase.projectRequirement.findMany.mockResolvedValue([{
      id: 20,
      projectId: 1,
      dayOfWeek: "MONDAY",
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      requiredEmployees: 1,
      requiredSkillId: 1,
      minimumSkillLevel: 3,
      priority: "HIGH",
      activeFrom: null,
      activeUntil: null,
    }]);

    const preview = await buildPortfolioPlanPreview(planningDatabase, {
      horizonStart: "2026-08-10",
      horizonWeeks: 1,
      replaceGenerated: true,
    });

    expect(preview.metrics).toMatchObject({
      proposedFixedCoverageMinutes: 480,
      fixedCoverageCostCents: 48_000,
      workPackageCostCents: 0,
      plannedCostCents: 48_000,
    });
    expect(preview.projectCostSummaries[0]).toMatchObject({
      fixedCoverageCostCents: 48_000,
      totalBudgetVarianceCents: -52_000,
    });
    expect(preview.projectCostSummaries[0]?.weeks[0]).toMatchObject({
      plannedCostCents: 48_000,
      weeklyBudgetVarianceCents: -2_000,
    });
  });

  it("topologically schedules a successor after its predecessor", async () => {
    const predecessor = workPackage({ id: 10, name: "Design", remainingMinutes: 240, estimatedMinutes: 240, sortOrder: 2 });
    const successor = workPackage({
      id: 11,
      name: "Build",
      remainingMinutes: 240,
      estimatedMinutes: 240,
      sortOrder: 1,
      incomingDependencies: [{
        predecessorId: 10,
        successorId: 11,
        lagMinutes: 0,
        predecessor: predecessor,
      }],
    });
    const preview = await buildPortfolioPlanPreview(database([project([successor, predecessor])]), {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });

    const predecessorEnd = Math.max(...preview.assignments.filter((item) => item.workPackageId === 10).map((item) => new Date(item.endAt).getTime()));
    const successorStart = Math.min(...preview.assignments.filter((item) => item.workPackageId === 11).map((item) => new Date(item.startAt).getTime()));
    expect(successorStart).toBeGreaterThanOrEqual(predecessorEnd);
  });

  it("preserves a dependency boundary across planning weeks", async () => {
    const predecessor = workPackage({
      id: 10,
      name: "Foundation",
      estimatedMinutes: 2_400,
      remainingMinutes: 2_400,
    });
    const successor = workPackage({
      id: 11,
      name: "Release",
      estimatedMinutes: 480,
      remainingMinutes: 480,
      incomingDependencies: [{
        predecessorId: 10,
        successorId: 11,
        lagMinutes: 0,
        predecessor,
      }],
    });

    const preview = await buildPortfolioPlanPreview(
      database([project([successor, predecessor])]),
      { horizonStart: "2026-08-10", horizonWeeks: 2, replaceGenerated: true },
    );

    const predecessorEnd = Math.max(...preview.assignments
      .filter((item) => item.workPackageId === 10)
      .map((item) => new Date(item.endAt).getTime()));
    const successorAssignment = preview.assignments.find(
      (item) => item.workPackageId === 11,
    );
    expect(successorAssignment?.startAt).toBe("2026-08-17T07:00:00.000Z");
    expect(new Date(successorAssignment!.startAt).getTime()).toBeGreaterThan(predecessorEnd);
  });

  it("does not schedule hard-deadline work after the target date", async () => {
    const constrained = project([
      workPackage({ remainingMinutes: 960, estimatedMinutes: 960 }),
    ], {
      deadlineType: "HARD",
      targetEndDate: new Date("2026-08-10T00:00:00.000Z"),
    });
    const preview = await buildPortfolioPlanPreview(database([constrained]), {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });

    expect(preview.assignments.every((item) => item.startAt.startsWith("2026-08-10"))).toBe(true);
    expect(preview.unplannedWorkPackages[0]?.unplannedMinutes).toBe(480);
  });

  it("uses the Vienna calendar deadline on the DST transition day", async () => {
    const sundayAvailability = [{
      id: 1,
      employeeId: 1,
      dayOfWeek: "SUNDAY",
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    }];
    const constrained = project([workPackage()], {
      startDate: new Date("2026-03-23T00:00:00.000Z"),
      targetEndDate: new Date("2026-03-29T00:00:00.000Z"),
      deadlineType: "HARD",
    });
    const preview = await buildPortfolioPlanPreview(database(
      [constrained],
      [],
      [employee({ availability: sundayAvailability })],
    ), {
      horizonStart: "2026-03-23",
      horizonWeeks: 1,
      replaceGenerated: true,
    });

    expect(preview.assignments[0]).toMatchObject({
      startAt: "2026-03-29T07:00:00.000Z",
      endAt: "2026-03-29T15:00:00.000Z",
    });
    expect(preview.unplannedWorkPackages).toEqual([]);
  });

  it("replaces generated occupancy but always preserves manual shifts", async () => {
    const baseShift = {
      id: 100,
      employeeId: 1,
      projectId: 99,
      workPackageId: null,
      projectRequirementId: null,
      planningRunId: null,
      startAt: new Date("2026-08-10T07:00:00.000Z"),
      endAt: new Date("2026-08-10T11:00:00.000Z"),
      note: null,
      kind: "GENERAL",
      status: "COMMITTED",
      plannedCostCents: null,
      cancelledAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const replaced = await buildPortfolioPlanPreview(database([project()], [{ ...baseShift, origin: "SOLVER" }]), {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });
    const preserved = await buildPortfolioPlanPreview(database([project()], [{ ...baseShift, origin: "MANUAL" }]), {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });

    expect(replaced.assignments[0]?.startAt).toBe("2026-08-10T07:00:00.000Z");
    expect(preserved.assignments[0]?.startAt).toBe("2026-08-10T11:00:00.000Z");
  });

  it("recognizes retained planned scope when unlocking a dependency", async () => {
    const predecessor = workPackage({ id: 10, name: "Design", remainingMinutes: 240, estimatedMinutes: 240 });
    const successor = workPackage({
      id: 11,
      name: "Build",
      remainingMinutes: 240,
      estimatedMinutes: 240,
      incomingDependencies: [{ predecessorId: 10, successorId: 11, lagMinutes: 0, predecessor }],
    });
    const retainedAllocation = {
      id: 101,
      employeeId: 1,
      projectId: 1,
      workPackageId: 10,
      projectRequirementId: null,
      planningRunId: null,
      startAt: new Date("2026-08-10T07:00:00.000Z"),
      endAt: new Date("2026-08-10T11:00:00.000Z"),
      note: null,
      kind: "WORK_PACKAGE",
      origin: "MANUAL",
      status: "COMMITTED",
      plannedCostCents: 24_000,
      cancelledAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const preview = await buildPortfolioPlanPreview(
      database([project([successor, predecessor])], [retainedAllocation]),
      { horizonStart: "2026-08-10", horizonWeeks: 2, replaceGenerated: true },
    );

    expect(preview.assignments.some((item) => item.workPackageId === 10)).toBe(false);
    expect(preview.assignments.find((item) => item.workPackageId === 11)?.startAt).toBe("2026-08-10T11:00:00.000Z");
  });
});
