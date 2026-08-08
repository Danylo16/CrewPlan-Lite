import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

const prismaMock = vi.hoisted(() => ({
  employee: {
    findMany: vi.fn(),
  },

  projectRequirement: {
    findMany: vi.fn(),
  },

  shift: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },

  $transaction: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: prismaMock,
}));

import { app } from "../src/app.js";

const employee = {
  id: 1,
  preferredWeeklyMinutes: 2400,
  maxWeeklyMinutes: 2400,

  skills: [
    {
      skillId: 1,
      level: 3,
    },
  ],

  availability: [
    {
      dayOfWeek: "MONDAY",
      startMinute: 540,
      endMinute: 1020,
    },
  ],
};

const requirement = {
  id: 10,
  projectId: 2,
  dayOfWeek: "MONDAY",
  startMinute: 540,
  endMinute: 1020,
  requiredEmployees: 1,
  requiredSkillId: 1,
  minimumSkillLevel: 3,
  priority: "HIGH",
};

describe("schedule generation API", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    prismaMock.employee.findMany
      .mockResolvedValue([employee]);

    prismaMock.projectRequirement.findMany
      .mockResolvedValue([requirement]);

    prismaMock.shift.findMany
      .mockResolvedValue([]);

    prismaMock.shift.deleteMany
      .mockResolvedValue({
        count: 0,
      });

    prismaMock.shift.createMany
      .mockResolvedValue({
        count: 1,
      });

    prismaMock.$transaction
      .mockImplementation(
        async (callback) =>
          callback(prismaMock),
      );
  });

  it("rejects a week start that is not Monday", async () => {
    const response = await request(app)
      .post("/api/schedule/generate")
      .send({
        weekStart: "2026-08-11",
      });

    expect(response.status).toBe(400);

    expect(response.body.code).toBe(
      "WEEK_START_NOT_MONDAY",
    );

    expect(
      prismaMock.employee.findMany,
    ).not.toHaveBeenCalled();
  });

  it("returns a deterministic UTC schedule preview", async () => {
    const firstResponse = await request(app)
      .post("/api/schedule/generate")
      .send({
        weekStart: "2026-08-10",
      });

    const secondResponse = await request(app)
      .post("/api/schedule/generate")
      .send({
        weekStart: "2026-08-10",
      });

    expect(firstResponse.status).toBe(200);

    expect(firstResponse.body.previewId).toBe(
      secondResponse.body.previewId,
    );

    expect(firstResponse.body.inputVersion).toBe(
      secondResponse.body.inputVersion,
    );

    expect(firstResponse.body.timezone).toBe(
      "Europe/Vienna",
    );

    expect(
      firstResponse.body.metrics.coveragePercent,
    ).toBe(100);

    expect(
      firstResponse.body.assignments[0],
    ).toMatchObject({
      requirementId: 10,
      employeeId: 1,
      startAt: "2026-08-10T07:00:00.000Z",
      endAt: "2026-08-10T15:00:00.000Z",
    });
  });

  it("treats a stored shift as a conflict by default", async () => {
    prismaMock.shift.findMany
      .mockResolvedValue([
        {
          id: 30,
          employeeId: 1,
          projectId: 99,
          origin: "SOLVER",
          status: "COMMITTED",

          startAt: new Date(
            "2026-08-10T07:00:00.000Z",
          ),

          endAt: new Date(
            "2026-08-10T11:00:00.000Z",
          ),

          updatedAt: new Date(
            "2026-08-01T12:00:00.000Z",
          ),
        },
      ]);

    const response = await request(app)
      .post("/api/schedule/generate")
      .send({
        weekStart: "2026-08-10",
      });

    expect(response.status).toBe(200);
    expect(response.body.assignments).toHaveLength(0);

    expect(
      response.body
        .unfilledRequirements[0]
        .rejectionCounts
        .OVERLAP,
    ).toBe(1);
  });

  it("counts a matching stored shift as fulfilled and creates no duplicate", async () => {
    prismaMock.shift.findMany.mockResolvedValue([{
      id: 31,
      employeeId: 1,
      projectId: 2,
      startAt: new Date("2026-08-10T07:00:00.000Z"),
      endAt: new Date("2026-08-10T15:00:00.000Z"),
      updatedAt: new Date("2026-08-01T12:00:00.000Z"),
    }]);

    const response = await request(app)
      .post("/api/schedule/generate")
      .send({ weekStart: "2026-08-10" });

    expect(response.status).toBe(200);
    expect(response.body.assignments).toHaveLength(0);
    expect(response.body.existingAssignments).toEqual([{
      shiftId: 31,
      requirementId: 10,
      positionIndex: 0,
      employeeId: 1,
      projectId: 2,
    }]);
    expect(response.body.unfilledRequirements).toHaveLength(0);
    expect(response.body.metrics).toMatchObject({
      requestedPositions: 1,
      assignedPositions: 1,
      existingPositions: 1,
      proposedPositions: 0,
      coveragePercent: 100,
    });
  });

  it("does not count a matching shift when the employee lacks the skill", async () => {
    prismaMock.employee.findMany.mockResolvedValue([{
      ...employee,
      skills: [{ skillId: 1, level: 2 }],
    }]);
    prismaMock.shift.findMany.mockResolvedValue([{
      id: 32,
      employeeId: 1,
      projectId: 2,
      startAt: new Date("2026-08-10T07:00:00.000Z"),
      endAt: new Date("2026-08-10T15:00:00.000Z"),
      updatedAt: new Date("2026-08-01T12:00:00.000Z"),
    }]);

    const response = await request(app)
      .post("/api/schedule/generate")
      .send({ weekStart: "2026-08-10" });

    expect(response.status).toBe(200);
    expect(response.body.existingAssignments).toHaveLength(0);
    expect(response.body.metrics.coveragePercent).toBe(0);
    expect(response.body.unfilledRequirements).toHaveLength(1);
  });

  it("ignores stored shifts when replacement is requested", async () => {
    prismaMock.shift.findMany
      .mockResolvedValue([
        {
          id: 30,
          employeeId: 1,
          projectId: 99,
          origin: "SOLVER",
          status: "COMMITTED",

          startAt: new Date(
            "2026-08-10T07:00:00.000Z",
          ),

          endAt: new Date(
            "2026-08-10T11:00:00.000Z",
          ),

          updatedAt: new Date(
            "2026-08-01T12:00:00.000Z",
          ),
        },
      ]);

    const response = await request(app)
      .post("/api/schedule/generate")
      .send({
        weekStart: "2026-08-10",
        replaceExisting: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.assignments).toHaveLength(1);
    expect(response.body.replaceExisting).toBe(true);
  });

  it("preserves manual shifts when generated allocations are replaced", async () => {
    prismaMock.shift.findMany.mockResolvedValue([{
      id: 40,
      employeeId: 1,
      projectId: 99,
      origin: "MANUAL",
      status: "COMMITTED",
      startAt: new Date("2026-08-10T07:00:00.000Z"),
      endAt: new Date("2026-08-10T11:00:00.000Z"),
      updatedAt: new Date("2026-08-01T12:00:00.000Z"),
    }]);

    const response = await request(app)
      .post("/api/schedule/generate")
      .send({ weekStart: "2026-08-10", replaceExisting: true });

    expect(response.status).toBe(200);
    expect(response.body.assignments).toHaveLength(0);
    expect(response.body.unfilledRequirements[0].rejectionCounts.OVERLAP).toBe(1);
  });

  it("rejects a stale preview without writing shifts", async () => {
    const response = await request(app)
      .post("/api/schedule/apply")
      .send({
        weekStart: "2026-08-10",
        previewId: "0".repeat(64),
        inputVersion: "1".repeat(64),
      });

    expect(response.status).toBe(409);

    expect(response.body.code).toBe(
      "SCHEDULE_PREVIEW_STALE",
    );

    expect(
      prismaMock.shift.createMany,
    ).not.toHaveBeenCalled();
  });

  it("rebuilds and applies a valid preview transactionally", async () => {
    const previewResponse = await request(app)
      .post("/api/schedule/generate")
      .send({
        weekStart: "2026-08-10",
      });

    const applyResponse = await request(app)
      .post("/api/schedule/apply")
      .send({
        weekStart: "2026-08-10",

        previewId:
          previewResponse.body.previewId,

        inputVersion:
          previewResponse.body.inputVersion,
      });

    expect(applyResponse.status).toBe(201);

    expect(
      applyResponse.body.createdShifts,
    ).toBe(1);

    expect(
      applyResponse.body.deletedShifts,
    ).toBe(0);

    expect(
      prismaMock.shift.createMany,
    ).toHaveBeenCalledOnce();

    expect(prismaMock.shift.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        kind: "FIXED_COVERAGE",
        origin: "SOLVER",
        projectRequirementId: 10,
      })],
    });

    expect(
      prismaMock.shift.deleteMany,
    ).not.toHaveBeenCalled();
  });

  it("replaces overlapping week shifts inside the transaction", async () => {
    prismaMock.shift.findMany
      .mockResolvedValue([
        {
          id: 30,
          employeeId: 1,
          projectId: 99,
          origin: "SOLVER",
          status: "COMMITTED",

          startAt: new Date(
            "2026-08-10T07:00:00.000Z",
          ),

          endAt: new Date(
            "2026-08-10T11:00:00.000Z",
          ),

          updatedAt: new Date(
            "2026-08-01T12:00:00.000Z",
          ),
        },
      ]);

    prismaMock.shift.deleteMany
      .mockResolvedValue({
        count: 1,
      });

    const previewResponse = await request(app)
      .post("/api/schedule/generate")
      .send({
        weekStart: "2026-08-10",
        replaceExisting: true,
      });

    const applyResponse = await request(app)
      .post("/api/schedule/apply")
      .send({
        weekStart: "2026-08-10",
        replaceExisting: true,

        previewId:
          previewResponse.body.previewId,

        inputVersion:
          previewResponse.body.inputVersion,
      });

    expect(applyResponse.status).toBe(201);

    expect(
      applyResponse.body.deletedShifts,
    ).toBe(1);

    expect(
      prismaMock.shift.deleteMany,
    ).toHaveBeenCalledOnce();

    expect(
      prismaMock.shift.createMany,
    ).toHaveBeenCalledOnce();
  });
});
