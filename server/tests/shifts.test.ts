import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

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
  shift: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
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
});