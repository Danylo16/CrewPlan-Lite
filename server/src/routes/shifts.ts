import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export const shiftRouter = Router();

const createShiftSchema = z.object({
  employeeId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(500).optional(),
});

const updateShiftSchema = z.object({
  employeeId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(500).nullable().optional(),
});

const shiftIdSchema = z.coerce.number().int().positive();

const shiftQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

shiftRouter.get("/", async (request, response) => {
  const validationResult = shiftQuerySchema.safeParse(request.query);

  if (!validationResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid date range",
      errors: validationResult.error.issues,
    });
  }

  const { from, to } = validationResult.data;
  const where: Prisma.ShiftWhereInput = {};

  if (from) {
    where.endAt = {
      gt: new Date(from),
    };
  }

  if (to) {
    where.startAt = {
      lt: new Date(to),
    };
  }

  const shifts = await prisma.shift.findMany({
    where,
    include: {
      employee: true,
      project: true,
    },
    orderBy: {
      startAt: "asc",
    },
  });

  return response.json(shifts);
});

shiftRouter.post("/", async (request, response) => {
  const validationResult = createShiftSchema.safeParse(request.body);

  if (!validationResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid shift data",
      errors: validationResult.error.issues,
    });
  }

  const { employeeId, projectId, startAt, endAt, note } =
    validationResult.data;

  const startDate = new Date(startAt);
  const endDate = new Date(endAt);

  if (endDate <= startDate) {
    return response.status(400).json({
      code: "INVALID_TIME_RANGE",
      message: "Shift end must be after shift start",
    });
  }

  const [employee, project] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: employeeId },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
    }),
  ]);

  if (!employee) {
    return response.status(404).json({
      code: "EMPLOYEE_NOT_FOUND",
      message: "Employee does not exist",
    });
  }

  if (!project) {
    return response.status(404).json({
      code: "PROJECT_NOT_FOUND",
      message: "Project does not exist",
    });
  }

  const conflictingShift = await prisma.shift.findFirst({
    where: {
      employeeId,
      startAt: {
        lt: endDate,
      },
      endAt: {
        gt: startDate,
      },
    },
    include: {
      project: true,
    },
  });

  if (conflictingShift) {
    return response.status(409).json({
      code: "SHIFT_OVERLAP",
      message: "Employee already has a shift during this period",
      conflict: {
        id: conflictingShift.id,
        startAt: conflictingShift.startAt,
        endAt: conflictingShift.endAt,
        project: conflictingShift.project.name,
      },
    });
  }

  try {
    const shift = await prisma.shift.create({
      data: {
        employeeId,
        projectId,
        startAt: startDate,
        endAt: endDate,
        ...(note !== undefined ? { note } : {}),
      },
      include: {
        employee: true,
        project: true,
      },
    });

    return response.status(201).json(shift);
  } catch (error) {
    console.error(error);

    return response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  }
});

shiftRouter.patch("/:id", async (request, response) => {
  const idResult = shiftIdSchema.safeParse(request.params.id);
  const bodyResult = updateShiftSchema.safeParse(request.body);

  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid shift data",
    });
  }

  const shiftId = idResult.data;
  const {
    employeeId,
    projectId,
    startAt,
    endAt,
    note,
  } = bodyResult.data;

  const startDate = new Date(startAt);
  const endDate = new Date(endAt);

  if (endDate <= startDate) {
    return response.status(400).json({
      code: "INVALID_TIME_RANGE",
      message: "Shift end must be after shift start",
    });
  }

  const [currentShift, employee, project] = await Promise.all([
    prisma.shift.findUnique({
      where: { id: shiftId },
    }),
    prisma.employee.findUnique({
      where: { id: employeeId },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
    }),
  ]);

  if (!currentShift) {
    return response.status(404).json({
      code: "SHIFT_NOT_FOUND",
      message: "Shift does not exist",
    });
  }

  if (!employee) {
    return response.status(404).json({
      code: "EMPLOYEE_NOT_FOUND",
      message: "Employee does not exist",
    });
  }

  if (!project) {
    return response.status(404).json({
      code: "PROJECT_NOT_FOUND",
      message: "Project does not exist",
    });
  }

  const conflictingShift = await prisma.shift.findFirst({
    where: {
      id: {
        not: shiftId,
      },
      employeeId,
      startAt: {
        lt: endDate,
      },
      endAt: {
        gt: startDate,
      },
    },
    include: {
      project: true,
    },
  });

  if (conflictingShift) {
    return response.status(409).json({
      code: "SHIFT_OVERLAP",
      message: "Employee already has a shift during this period",
      conflict: {
        id: conflictingShift.id,
        startAt: conflictingShift.startAt,
        endAt: conflictingShift.endAt,
        project: conflictingShift.project.name,
      },
    });
  }

  const updateData: Prisma.ShiftUncheckedUpdateInput = {
    employeeId,
    projectId,
    startAt: startDate,
    endAt: endDate,
  };

  if (note !== undefined) {
    updateData.note = note;
  }

  try {
    const shift = await prisma.shift.update({
      where: {
        id: shiftId,
      },
      data: updateData,
      include: {
        employee: true,
        project: true,
      },
    });

    return response.json(shift);
  } catch (error) {
    console.error(error);

    return response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  }
});

shiftRouter.delete("/:id", async (request, response) => {
  const idResult = shiftIdSchema.safeParse(request.params.id);

  if (!idResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid shift ID",
    });
  }

  try {
    await prisma.shift.delete({
      where: {
        id: idResult.data,
      },
    });

    return response.status(204).send();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return response.status(404).json({
        code: "SHIFT_NOT_FOUND",
        message: "Shift does not exist",
      });
    }

    console.error(error);

    return response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  }
});