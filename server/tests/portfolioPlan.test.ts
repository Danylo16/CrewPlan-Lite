import { describe, expect, it, vi } from "vitest";
import { buildPortfolioPlanPreview } from "../src/planning/portfolioPlan.js";

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
    employee: { findMany: vi.fn().mockResolvedValue(employees) },
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
    expect(preview.optimizerDiagnostics.algorithmVersion).toBe("portfolio-beam-v2");
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
