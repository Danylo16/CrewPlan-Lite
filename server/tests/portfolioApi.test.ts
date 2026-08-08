import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const prismaMock = vi.hoisted(() => ({
  employee: { findUnique: vi.fn() },
  project: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  skill: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  shift: { findUnique: vi.fn() },
  workPackage: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  workPackageDependency: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  workLog: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));

import { app } from "../src/app.js";

describe("portfolio API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
  });

  it("creates an empty draft project without fixed coverage", async () => {
    prismaMock.skill.findMany.mockResolvedValue([]);
    prismaMock.project.create.mockResolvedValue({
      id: 1,
      name: "Payments modernization",
      status: "DRAFT",
      deadlineType: "NONE",
      startDate: null,
      targetEndDate: null,
      _count: { shifts: 0, requirements: 0, workPackages: 0, workLogs: 0 },
    });

    const response = await request(app).post("/api/projects").send({
      name: "Payments modernization",
      color: "#2563EB",
    });

    expect(response.status).toBe(201);
    expect(response.body.requirementCount).toBe(0);
    expect(prismaMock.project.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        requirements: { create: [] },
        totalLaborBudgetCents: null,
      }),
    }));
  });

  it("creates a work package with remaining work equal to its estimate", async () => {
    prismaMock.project.findUnique.mockResolvedValue({ id: 1 });
    prismaMock.skill.findUnique.mockResolvedValue({ id: 2 });
    prismaMock.workPackage.create.mockResolvedValue({
      id: 10,
      projectId: 1,
      estimatedMinutes: 2_400,
      remainingMinutes: 2_400,
      requiredSkill: { id: 2, name: "TypeScript" },
    });

    const response = await request(app)
      .post("/api/projects/1/work-packages")
      .send({
        name: "Implement payment API",
        requiredSkillId: 2,
        estimatedMinutes: 2_400,
      });

    expect(response.status).toBe(201);
    expect(response.body.completedMinutes).toBe(0);
    expect(prismaMock.workPackage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ remainingMinutes: 2_400 }),
    }));
  });

  it("confirms actual work and decrements remaining scope atomically", async () => {
    const workLog = {
      id: 50,
      employeeId: 3,
      projectId: 1,
      workPackageId: 10,
      status: "DRAFT",
      startedAt: new Date("2026-08-10T07:00:00.000Z"),
      endedAt: new Date("2026-08-10T09:00:00.000Z"),
      employee: { hourlyCostCents: 4_200 },
      workPackage: { remainingMinutes: 180 },
    };
    prismaMock.workLog.findUnique.mockResolvedValue(workLog);
    prismaMock.workPackage.update.mockResolvedValue({});
    prismaMock.workLog.update.mockResolvedValue({
      ...workLog,
      status: "CONFIRMED",
      actualCostCents: 8_400,
      remainingMinutesApplied: 120,
    });

    const response = await request(app).post("/api/work-logs/50/confirm").send();

    expect(response.status).toBe(200);
    expect(response.body.actualCostCents).toBe(8_400);
    expect(prismaMock.workPackage.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { remainingMinutes: { decrement: 120 } },
    });
    expect(prismaMock.workLog.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ remainingMinutesApplied: 120 }),
    }));
  });
});
