import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Prisma } from "../src/generated/prisma/client.js";

const prismaMock = vi.hoisted(() => ({
  employee: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  project: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  skill: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  projectRequirement: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  shift: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: prismaMock,
}));

import { app } from "../src/app.js";

describe("CrewPlan API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns API health status", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("rejects invalid shift data", async () => {
    const response = await request(app)
      .post("/api/shifts")
      .send({
        employeeId: "not-a-number",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a shift ending before it starts", async () => {
    const response = await request(app)
      .post("/api/shifts")
      .send({
        employeeId: 1,
        projectId: 1,
        startAt: "2026-07-30T17:00:00.000Z",
        endAt: "2026-07-30T09:00:00.000Z",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_TIME_RANGE");
  });

  it("rejects an employee profile with overlapping availability", async () => {
    const response = await request(app)
      .put("/api/employees/1/scheduling-profile")
      .send({
        preferredWeeklyMinutes: 1800,
        maxWeeklyMinutes: 2400,
        skills: [],
        availability: [
          {
            dayOfWeek: "MONDAY",
            startMinute: 540,
            endMinute: 780,
          },
          {
            dayOfWeek: "MONDAY",
            startMinute: 720,
            endMinute: 1020,
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("creates a scheduler-ready employee profile atomically", async () => {
    prismaMock.skill.findMany.mockResolvedValue([{ id: 2 }]);
    prismaMock.employee.create.mockResolvedValue({
      id: 9,
      name: "Mia Berger",
      email: "mia@crewplan.at",
      role: "Backend Developer",
      preferredWeeklyMinutes: 1920,
      maxWeeklyMinutes: 2400,
      hourlyCostCents: 4200,
      overtimeRateBasisPoints: 15000,
      skills: [{ skillId: 2, level: 4 }],
      availability: [{ dayOfWeek: "MONDAY", startMinute: 540, endMinute: 1020 }],
    });

    const response = await request(app).post("/api/employees").send({
      name: "Mia Berger",
      email: "mia@crewplan.at",
      role: "Backend Developer",
      preferredWeeklyMinutes: 1920,
      maxWeeklyMinutes: 2400,
      hourlyCostCents: 4200,
      overtimeRateBasisPoints: 15000,
      skills: [{ skillId: 2, level: 4 }],
      availability: [{ dayOfWeek: "MONDAY", startMinute: 540, endMinute: 1020 }],
    });

    expect(response.status).toBe(201);
    expect(prismaMock.employee.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        hourlyCostCents: 4200,
        skills: { create: [expect.objectContaining({ level: 4 })] },
      }),
    }));
  });

  it("creates a project together with its budget and requirements", async () => {
    prismaMock.skill.findMany.mockResolvedValue([{ id: 2 }]);
    prismaMock.project.create.mockResolvedValue({
      id: 4,
      name: "Payments",
      color: "#2563EB",
      weeklyLaborBudgetCents: 800000,
      _count: { shifts: 0, requirements: 1 },
    });

    const response = await request(app).post("/api/projects").send({
      name: "Payments",
      color: "#2563EB",
      weeklyLaborBudgetCents: 800000,
      requirements: [{
        dayOfWeek: "MONDAY",
        startMinute: 540,
        endMinute: 1020,
        requiredEmployees: 2,
        requiredSkillId: 2,
        minimumSkillLevel: 3,
        priority: "HIGH",
      }],
    });

    expect(response.status).toBe(201);
    expect(response.body.requirementCount).toBe(1);
    expect(prismaMock.project.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        weeklyLaborBudgetCents: 800000,
        requirements: { create: [expect.objectContaining({ priority: "HIGH" })] },
      }),
    }));
  });

  it("rejects a requirement skill level without a selected skill", async () => {
    const response = await request(app)
      .post("/api/project-requirements")
      .send({
        projectId: 1,
        dayOfWeek: "MONDAY",
        startMinute: 540,
        endMinute: 1020,
        requiredEmployees: 2,
        requiredSkillId: null,
        minimumSkillLevel: 3,
        priority: "HIGH",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("creates a valid project staffing requirement", async () => {
    prismaMock.project.findUnique.mockResolvedValue({ id: 1 });
    prismaMock.skill.findUnique.mockResolvedValue({ id: 2 });
    prismaMock.projectRequirement.create.mockResolvedValue({
      id: 20,
      projectId: 1,
      dayOfWeek: "MONDAY",
      startMinute: 540,
      endMinute: 1020,
      requiredEmployees: 2,
      requiredSkillId: 2,
      minimumSkillLevel: 3,
      priority: "HIGH",
      project: { id: 1, name: "Mobile Banking" },
      requiredSkill: { id: 2, name: "TypeScript" },
    });

    const response = await request(app)
      .post("/api/project-requirements")
      .send({
        projectId: 1,
        dayOfWeek: "MONDAY",
        startMinute: 540,
        endMinute: 1020,
        requiredEmployees: 2,
        requiredSkillId: 2,
        minimumSkillLevel: 3,
        priority: "HIGH",
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(20);
    expect(prismaMock.projectRequirement.create).toHaveBeenCalledOnce();
  });

  it("rejects an overlapping shift", async () => {
    prismaMock.employee.findUnique.mockResolvedValue({
      id: 1,
    });

    prismaMock.project.findUnique.mockResolvedValue({
      id: 1,
    });

    prismaMock.shift.findFirst.mockResolvedValue({
      id: 10,
      startAt: new Date("2026-07-30T09:00:00.000Z"),
      endAt: new Date("2026-07-30T13:00:00.000Z"),
      project: {
        name: "Mobile Banking",
      },
    });

    const response = await request(app)
      .post("/api/shifts")
      .send({
        employeeId: 1,
        projectId: 1,
        startAt: "2026-07-30T12:00:00.000Z",
        endAt: "2026-07-30T16:00:00.000Z",
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("SHIFT_OVERLAP");
    expect(prismaMock.shift.create).not.toHaveBeenCalled();
  });

  it("allows adjacent shifts", async () => {
    prismaMock.employee.findUnique.mockResolvedValue({
      id: 1,
    });

    prismaMock.project.findUnique.mockResolvedValue({
      id: 2,
    });

    prismaMock.shift.findFirst.mockResolvedValue(null);

    prismaMock.shift.create.mockResolvedValue({
      id: 11,
      employeeId: 1,
      projectId: 2,
      startAt: new Date("2026-07-30T13:00:00.000Z"),
      endAt: new Date("2026-07-30T17:00:00.000Z"),
      note: null,
      employee: {
        id: 1,
        name: "Anna Mueller",
      },
      project: {
        id: 2,
        name: "Internal Dashboard",
      },
    });

    const response = await request(app)
      .post("/api/shifts")
      .send({
        employeeId: 1,
        projectId: 2,
        startAt: "2026-07-30T13:00:00.000Z",
        endAt: "2026-07-30T17:00:00.000Z",
      });

    expect(response.status).toBe(201);
    expect(prismaMock.shift.create).toHaveBeenCalledOnce();
  });

  it("updates an existing shift", async () => {
    prismaMock.shift.findUnique.mockResolvedValue({
      id: 11,
      employeeId: 1,
      projectId: 2,
    });

    prismaMock.employee.findUnique.mockResolvedValue({
      id: 1,
    });

    prismaMock.project.findUnique.mockResolvedValue({
      id: 3,
    });

    prismaMock.shift.findFirst.mockResolvedValue(null);

    prismaMock.shift.update.mockResolvedValue({
      id: 11,
      employeeId: 1,
      projectId: 3,
      startAt: new Date("2026-07-30T14:00:00.000Z"),
      endAt: new Date("2026-07-30T18:00:00.000Z"),
      note: "Updated work",
      employee: {
        id: 1,
        name: "Anna Mueller",
      },
      project: {
        id: 3,
        name: "Customer Portal",
        color: "#5A2F0C",
      },
    });

    const response = await request(app)
      .patch("/api/shifts/11")
      .send({
        employeeId: 1,
        projectId: 3,
        startAt: "2026-07-30T14:00:00.000Z",
        endAt: "2026-07-30T18:00:00.000Z",
        note: "Updated work",
      });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(11);
    expect(response.body.projectId).toBe(3);
    expect(response.body.note).toBe("Updated work");

    expect(prismaMock.shift.update).toHaveBeenCalledWith({
      where: {
        id: 11,
      },
      data: {
        employeeId: 1,
        projectId: 3,
        startAt: new Date("2026-07-30T14:00:00.000Z"),
        endAt: new Date("2026-07-30T18:00:00.000Z"),
        note: "Updated work",
      },
      include: {
        employee: true,
        project: true,
      },
    });
  });

  it("rejects an overlapping shift update", async () => {
    prismaMock.shift.findUnique.mockResolvedValue({
      id: 11,
      employeeId: 1,
      projectId: 2,
    });

    prismaMock.employee.findUnique.mockResolvedValue({
      id: 1,
    });

    prismaMock.project.findUnique.mockResolvedValue({
      id: 3,
    });

    prismaMock.shift.findFirst.mockResolvedValue({
      id: 12,
      startAt: new Date("2026-07-30T15:00:00.000Z"),
      endAt: new Date("2026-07-30T19:00:00.000Z"),
      project: {
        name: "Internal Dashboard",
      },
    });

    const response = await request(app)
      .patch("/api/shifts/11")
      .send({
        employeeId: 1,
        projectId: 3,
        startAt: "2026-07-30T14:00:00.000Z",
        endAt: "2026-07-30T18:00:00.000Z",
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("SHIFT_OVERLAP");
    expect(response.body.conflict.id).toBe(12);

    expect(prismaMock.shift.findFirst).toHaveBeenCalledWith({
      where: {
        id: {
          not: 11,
        },
        employeeId: 1,
        startAt: {
          lt: new Date("2026-07-30T18:00:00.000Z"),
        },
        endAt: {
          gt: new Date("2026-07-30T14:00:00.000Z"),
        },
      },
      include: {
        project: true,
      },
    });

    expect(prismaMock.shift.update).not.toHaveBeenCalled();
  });

  it("returns 404 when updating a missing shift", async () => {
    prismaMock.shift.findUnique.mockResolvedValue(null);

    prismaMock.employee.findUnique.mockResolvedValue({
      id: 1,
    });

    prismaMock.project.findUnique.mockResolvedValue({
      id: 2,
    });

    const response = await request(app)
      .patch("/api/shifts/999")
      .send({
        employeeId: 1,
        projectId: 2,
        startAt: "2026-07-30T13:00:00.000Z",
        endAt: "2026-07-30T17:00:00.000Z",
      });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("SHIFT_NOT_FOUND");
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.shift.update).not.toHaveBeenCalled();
  });

  it("deletes an existing shift", async () => {
    prismaMock.shift.delete.mockResolvedValue({
      id: 11,
    });

    const response = await request(app).delete("/api/shifts/11");

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});

    expect(prismaMock.shift.delete).toHaveBeenCalledWith({
      where: {
        id: 11,
      },
    });
  });

  it("returns 404 when deleting a missing shift", async () => {
    prismaMock.shift.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "No record was found for deletion",
        {
          code: "P2025",
          clientVersion: "6.19.3",
        },
      ),
    );

    const response = await request(app).delete("/api/shifts/999");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("SHIFT_NOT_FOUND");
    expect(response.body.message).toBe("Shift does not exist");
  });
});
