import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const previewMock = vi.hoisted(() => vi.fn());
const scenariosMock = vi.hoisted(() => vi.fn());
const resilienceMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  shift: { deleteMany: vi.fn(), createMany: vi.fn() },
  planningRun: { updateMany: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../src/planning/portfolioPlan.js", () => ({
  buildPortfolioPlanPreview: previewMock,
  buildPortfolioScenarioComparison: scenariosMock,
}));
vi.mock("../src/planning/portfolioResilience.js", () => ({ buildPortfolioResilienceReport: resilienceMock }));

import { app } from "../src/app.js";

const hash = "a".repeat(64);
const version = "b".repeat(64);
const preview = {
  previewId: hash,
  inputVersion: version,
  horizonStart: "2026-08-10",
  horizonEndExclusive: "2026-08-24",
  horizonWeeks: 2,
  planningProfile: "BALANCED",
  timezone: "Europe/Vienna",
  replaceGenerated: true,
  assignments: [{
    employeeId: 1,
    projectId: 1,
    workPackageId: 10,
    startAt: "2026-08-10T07:00:00.000Z",
    endAt: "2026-08-10T11:00:00.000Z",
    plannedCostCents: 24_000,
  }],
  fixedCoverageAssignments: [{
    employeeId: 2,
    projectId: 1,
    projectRequirementId: 5,
    startAt: "2026-08-11T07:00:00.000Z",
    endAt: "2026-08-11T09:00:00.000Z",
  }],
  optimizerDiagnostics: { runtimeMs: 12 },
  metrics: { proposedWorkMinutes: 240, proposedFixedCoverageMinutes: 120, plannedCostCents: 24_000, assignedWorkPackages: 1, unplannedWorkPackages: 0 },
};

describe("portfolio planning API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
    prismaMock.shift.deleteMany.mockResolvedValue({ count: 3 });
    prismaMock.shift.createMany.mockResolvedValue({ count: 2 });
    prismaMock.planningRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.planningRun.create.mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });
    previewMock.mockResolvedValue(preview);
    scenariosMock.mockResolvedValue({
      comparisonId: hash,
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      runtimeMs: 20,
      runtimeBreakdown: {
        preOptimizerMs: 5,
        optimizerMs: 12,
        postOptimizerMs: 3,
      },
      scenarios: [{ planningProfile: "BALANCED", plannedCostCents: 24_000 }],
    });
    resilienceMock.mockResolvedValue({
      previewId: hash,
      inputVersion: version,
      scorePercent: 82,
      worstCaseCoveragePercent: 70,
      testedAbsences: 5,
      recoverableAbsences: 4,
      runtimeBreakdown: {
        baselineMs: 10,
        preparationMs: 2,
        repairMs: 8,
      },
      scenarios: [],
    });
  });

  it("rebuilds and applies a valid preview transactionally", async () => {
    const response = await request(app).post("/api/portfolio-plan/apply").send({
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      planningProfile: "BALANCED",
      previewId: hash,
      inputVersion: version,
    });

    expect(response.status).toBe(201);
    expect(previewMock).toHaveBeenCalledWith(prismaMock, {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      planningProfile: "BALANCED",
    });
    expect(response.body.createdShifts).toBe(2);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["server-timing"]).toMatch(/^total;dur=/);
    expect(prismaMock.shift.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ origin: "SOLVER", status: "COMMITTED" }),
    });
    expect(prismaMock.shift.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ kind: "WORK_PACKAGE", workPackageId: 10 }),
        expect.objectContaining({ kind: "FIXED_COVERAGE", projectRequirementId: 5 }),
      ]),
    });
  });

  it("returns uncached preview timing and a request correlation ID", async () => {
    const response = await request(app).post("/api/portfolio-plan/preview").send({
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      planningProfile: "BALANCED",
    });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.headers["server-timing"]).toContain("optimizer;dur=12.0");
  });

  it("compares every planning profile without applying a plan", async () => {
    const response = await request(app).post("/api/portfolio-plan/scenarios").send({
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });

    expect(response.status).toBe(200);
    expect(response.body.scenarios).toHaveLength(1);
    expect(response.headers["server-timing"]).toContain("pre_optimizer;dur=5.0");
    expect(response.headers["server-timing"]).toContain("optimizer;dur=12.0");
    expect(response.headers["server-timing"]).toContain("post_optimizer;dur=3.0");
    expect(scenariosMock).toHaveBeenCalledWith(prismaMock, {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a stale preview without deleting shifts", async () => {
    previewMock.mockResolvedValue({ ...preview, previewId: "c".repeat(64) });
    const response = await request(app).post("/api/portfolio-plan/apply").send({
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      previewId: hash,
      inputVersion: version,
      planningProfile: "BALANCED",
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("PORTFOLIO_PREVIEW_STALE");
    expect(response.body).toMatchObject({
      retryable: true,
      recovery: "REGENERATE_PREVIEW",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-crewplan-recovery"]).toBe("regenerate-preview");
    expect(prismaMock.shift.deleteMany).not.toHaveBeenCalled();
  });

  it("runs a resilience stress test against the accepted preview", async () => {
    const response = await request(app).post("/api/portfolio-plan/resilience").send({
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      previewId: hash,
      inputVersion: version,
      planningProfile: "BALANCED",
    });

    expect(response.status).toBe(200);
    expect(response.body.scorePercent).toBe(82);
    expect(response.headers["server-timing"]).toContain("baseline;dur=10.0");
    expect(response.headers["server-timing"]).toContain("preparation;dur=2.0");
    expect(response.headers["server-timing"]).toContain("repair;dur=8.0");
    expect(resilienceMock).toHaveBeenCalledWith(prismaMock, {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      previewId: hash,
      inputVersion: version,
      planningProfile: "BALANCED",
    });
  });

  it("returns a retry contract when resilience input is stale", async () => {
    resilienceMock.mockRejectedValue(new Error("PORTFOLIO_PREVIEW_STALE"));

    const response = await request(app).post("/api/portfolio-plan/resilience").send({
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      previewId: hash,
      inputVersion: version,
      planningProfile: "BALANCED",
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "PORTFOLIO_PREVIEW_STALE",
      retryable: true,
      recovery: "REGENERATE_PREVIEW",
    });
    expect(response.headers["server-timing"]).toMatch(/^total;dur=/);
  });
});
