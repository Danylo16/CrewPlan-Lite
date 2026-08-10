import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const previewMock = vi.hoisted(() => vi.fn());
const resilienceMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  shift: { deleteMany: vi.fn(), createMany: vi.fn() },
  planningRun: { updateMany: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../src/planning/portfolioPlan.js", () => ({ buildPortfolioPlanPreview: previewMock }));
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
    resilienceMock.mockResolvedValue({
      previewId: hash,
      inputVersion: version,
      scorePercent: 82,
      worstCaseCoveragePercent: 70,
      testedAbsences: 5,
      recoverableAbsences: 4,
      scenarios: [],
    });
  });

  it("rebuilds and applies a valid preview transactionally", async () => {
    const response = await request(app).post("/api/portfolio-plan/apply").send({
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      previewId: hash,
      inputVersion: version,
    });

    expect(response.status).toBe(201);
    expect(previewMock).toHaveBeenCalledWith(prismaMock, {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
    });
    expect(response.body.createdShifts).toBe(2);
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

  it("rejects a stale preview without deleting shifts", async () => {
    previewMock.mockResolvedValue({ ...preview, previewId: "c".repeat(64) });
    const response = await request(app).post("/api/portfolio-plan/apply").send({
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      previewId: hash,
      inputVersion: version,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("PORTFOLIO_PREVIEW_STALE");
    expect(prismaMock.shift.deleteMany).not.toHaveBeenCalled();
  });

  it("runs a resilience stress test against the accepted preview", async () => {
    const response = await request(app).post("/api/portfolio-plan/resilience").send({
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      previewId: hash,
      inputVersion: version,
    });

    expect(response.status).toBe(200);
    expect(response.body.scorePercent).toBe(82);
    expect(resilienceMock).toHaveBeenCalledWith(prismaMock, {
      horizonStart: "2026-08-10",
      horizonWeeks: 2,
      replaceGenerated: true,
      previewId: hash,
      inputVersion: version,
    });
  });
});
