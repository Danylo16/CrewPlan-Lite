import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const prismaMock = vi.hoisted(() => ({
  employee: { findUnique: vi.fn() },
  project: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
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
      workPackage: {
        remainingMinutes: 180,
        status: "IN_PROGRESS",
        incomingDependencies: [],
      },
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

  it("blocks a work package while a predecessor is unfinished", async () => {
    prismaMock.workPackage.findUnique.mockResolvedValue({
      id: 11,
      projectId: 1,
      remainingMinutes: 900,
      earliestStartDate: null,
      targetEndDate: null,
      incomingDependencies: [{
        predecessor: { id: 10, name: "Design", status: "IN_PROGRESS" },
      }],
    });

    const response = await request(app)
      .patch("/api/work-packages/11")
      .send({ status: "IN_PROGRESS" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("WORK_PACKAGE_BLOCKED");
    expect(response.body.blockers).toEqual([
      { id: 10, name: "Design", status: "IN_PROGRESS" },
    ]);
    expect(prismaMock.workPackage.update).not.toHaveBeenCalled();
  });

  it("rejects actual work for a package that has not started", async () => {
    prismaMock.employee.findUnique.mockResolvedValue({ id: 3 });
    prismaMock.project.findUnique.mockResolvedValue({ id: 1 });
    prismaMock.workPackage.findUnique.mockResolvedValue({
      id: 10,
      projectId: 1,
      status: "TODO",
      incomingDependencies: [],
    });

    const response = await request(app).post("/api/work-logs").send({
      employeeId: 3,
      projectId: 1,
      workPackageId: 10,
      startedAt: "2026-08-10T07:00:00.000Z",
      endedAt: "2026-08-10T08:00:00.000Z",
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("WORK_PACKAGE_NOT_IN_PROGRESS");
    expect(prismaMock.workLog.create).not.toHaveBeenCalled();
  });

  it("rejects project completion while work packages are unfinished", async () => {
    prismaMock.project.findUnique.mockResolvedValue({
      id: 1,
      status: "ACTIVE",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      _count: { workPackages: 2, requirements: 0 },
      workPackages: [
        { id: 10, name: "Design", status: "COMPLETED", remainingMinutes: 0 },
        { id: 11, name: "Build", status: "IN_PROGRESS", remainingMinutes: 900 },
      ],
    });

    const response = await request(app)
      .post("/api/projects/1/transition")
      .send({ status: "COMPLETED" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("PROJECT_HAS_UNFINISHED_WORK");
    expect(prismaMock.project.update).not.toHaveBeenCalled();
  });

  it("exposes the deployed API version", async () => {
    const response = await request(app).get("/api/version");

    expect(response.status).toBe(200);
    expect(response.body.service).toBe("crewplan-api");
    expect(response.body.commit).toBeTruthy();
  });
});
