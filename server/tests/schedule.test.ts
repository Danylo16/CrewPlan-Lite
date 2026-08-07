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
  },
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

    prismaMock.employee.findMany.mockResolvedValue([
      employee,
    ]);

    prismaMock.projectRequirement.findMany
      .mockResolvedValue([requirement]);

    prismaMock.shift.findMany.mockResolvedValue([]);
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
    prismaMock.shift.findMany.mockResolvedValue([
      {
        id: 30,
        employeeId: 1,
        projectId: 99,
        startAt: new Date(
          "2026-08-10T07:00:00.000Z",
        ),
        endAt: new Date(
          "2026-08-10T11:00:00.000Z",
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

  it("ignores stored shifts when replacement is requested", async () => {
    prismaMock.shift.findMany.mockResolvedValue([
      {
        id: 30,
        employeeId: 1,
        projectId: 99,
        startAt: new Date(
          "2026-08-10T07:00:00.000Z",
        ),
        endAt: new Date(
          "2026-08-10T11:00:00.000Z",
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
});