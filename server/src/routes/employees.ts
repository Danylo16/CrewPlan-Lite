import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export const employeeRouter = Router();

const dayOfWeekSchema = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

const employeeIdSchema = z.coerce.number().int().positive();

const schedulingProfileSchema = z.object({
  preferredWeeklyMinutes: z.number().int().min(0).max(10080),
  maxWeeklyMinutes: z.number().int().positive().max(10080),
  skills: z.array(z.object({
    skillId: z.number().int().positive(),
    level: z.number().int().min(1).max(5),
  })).max(50),
  availability: z.array(z.object({
    dayOfWeek: dayOfWeekSchema,
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  }).refine((slot) => slot.startMinute < slot.endMinute, {
    message: "Availability end must be after its start",
    path: ["endMinute"],
  })).max(50),
}).superRefine((data, context) => {
  if (data.preferredWeeklyMinutes > data.maxWeeklyMinutes) {
    context.addIssue({
      code: "custom",
      message: "Preferred weekly minutes cannot exceed the maximum",
      path: ["preferredWeeklyMinutes"],
    });
  }

  const skillIds = data.skills.map((skill) => skill.skillId);
  if (new Set(skillIds).size !== skillIds.length) {
    context.addIssue({
      code: "custom",
      message: "A skill may only appear once",
      path: ["skills"],
    });
  }

  const sortedSlots = [...data.availability].sort((first, second) =>
    first.dayOfWeek.localeCompare(second.dayOfWeek)
      || first.startMinute - second.startMinute,
  );

  for (let index = 1; index < sortedSlots.length; index += 1) {
    const previous = sortedSlots[index - 1];
    const current = sortedSlots[index];

    if (
      previous
      && current
      && previous.dayOfWeek === current.dayOfWeek
      && current.startMinute < previous.endMinute
    ) {
      context.addIssue({
        code: "custom",
        message: "Availability intervals cannot overlap",
        path: ["availability"],
      });
      break;
    }
  }
});

const createEmployeeSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().toLowerCase(),
  role: z.string().trim().min(2).max(100),
  hourlyCostCents: z.number().int().min(0).max(10_000_000),
  overtimeRateBasisPoints: z.number().int().min(10_000).max(50_000),
  preferredWeeklyMinutes: z.number().int().min(0).max(10080),
  maxWeeklyMinutes: z.number().int().positive().max(10080),
  skills: schedulingProfileSchema.shape.skills,
  availability: schedulingProfileSchema.shape.availability,
}).superRefine((data, context) => {
  const profileResult = schedulingProfileSchema.safeParse({
    preferredWeeklyMinutes: data.preferredWeeklyMinutes,
    maxWeeklyMinutes: data.maxWeeklyMinutes,
    skills: data.skills,
    availability: data.availability,
  });

  if (!profileResult.success) {
    for (const issue of profileResult.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.path,
      });
    }
  }
});

const updateEmployeeSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().email().toLowerCase().optional(),
  role: z.string().trim().min(2).max(100).optional(),
  hourlyCostCents: z.number().int().min(0).max(10_000_000).optional(),
  overtimeRateBasisPoints: z.number().int().min(10_000).max(50_000).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

const archiveEmployeeSchema = z.object({
  reason: z.string().trim().max(500).nullable().default(null),
  cancelFutureAllocations: z.boolean().default(false),
});

employeeRouter.get("/", async (request, response) => {
  const includeArchived = request.query.includeArchived === "true";
  const employees = await prisma.employee.findMany({
    ...(includeArchived ? {} : { where: { archivedAt: null } }),
    include: {
      skills: { include: { skill: true }, orderBy: { skillId: "asc" } },
      availability: {
        orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  response.json(employees);
});

employeeRouter.get("/:id/scheduling-profile", async (request, response) => {
  const idResult = employeeIdSchema.safeParse(request.params.id);

  if (!idResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid employee id",
    });
  }

  const employee = await prisma.employee.findUnique({
    where: { id: idResult.data },
    include: {
      skills: {
        include: { skill: true },
        orderBy: { skillId: "asc" },
      },
      availability: {
        orderBy: [
          { dayOfWeek: "asc" },
          { startMinute: "asc" },
        ],
      },
    },
  });

  if (!employee) {
    return response.status(404).json({
      code: "EMPLOYEE_NOT_FOUND",
      message: "Employee does not exist",
    });
  }

  return response.json(employee);
});

employeeRouter.put("/:id/scheduling-profile", async (request, response) => {
  const idResult = employeeIdSchema.safeParse(request.params.id);
  const bodyResult = schedulingProfileSchema.safeParse(request.body);

  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid scheduling profile",
      errors: bodyResult.success ? [] : bodyResult.error.issues,
    });
  }

  const employeeId = idResult.data;
  const profile = bodyResult.data;
  const [employee, skills] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId } }),
    prisma.skill.findMany({
      where: { id: { in: profile.skills.map((skill) => skill.skillId) } },
      select: { id: true },
    }),
  ]);

  if (!employee) {
    return response.status(404).json({
      code: "EMPLOYEE_NOT_FOUND",
      message: "Employee does not exist",
    });
  }

  if (skills.length !== profile.skills.length) {
    return response.status(400).json({
      code: "UNKNOWN_SKILL",
      message: "At least one selected skill does not exist",
    });
  }

  const updatedEmployee = await prisma.$transaction(async (transaction) => {
    await transaction.employeeSkill.deleteMany({ where: { employeeId } });
    await transaction.employeeAvailability.deleteMany({ where: { employeeId } });

    return transaction.employee.update({
      where: { id: employeeId },
      data: {
        preferredWeeklyMinutes: profile.preferredWeeklyMinutes,
        maxWeeklyMinutes: profile.maxWeeklyMinutes,
        skills: {
          create: profile.skills.map((skill) => ({
            level: skill.level,
            skill: { connect: { id: skill.skillId } },
          })),
        },
        availability: {
          create: profile.availability,
        },
      },
      include: {
        skills: { include: { skill: true } },
        availability: true,
      },
    });
  });

  return response.json(updatedEmployee);
});

employeeRouter.post("/", async (request, response) => {
  const validationResult = createEmployeeSchema.safeParse(request.body);

  if (!validationResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid employee data",
      errors: validationResult.error.issues,
    });
  }

  try {
    const data = validationResult.data;
    const skills = await prisma.skill.findMany({
      where: { id: { in: data.skills.map((skill) => skill.skillId) } },
      select: { id: true },
    });

    if (skills.length !== data.skills.length) {
      return response.status(400).json({
        code: "UNKNOWN_SKILL",
        message: "At least one selected skill does not exist",
      });
    }

    const employee = await prisma.employee.create({
      data: {
        name: data.name,
        email: data.email,
        role: data.role,
        hourlyCostCents: data.hourlyCostCents,
        overtimeRateBasisPoints: data.overtimeRateBasisPoints,
        preferredWeeklyMinutes: data.preferredWeeklyMinutes,
        maxWeeklyMinutes: data.maxWeeklyMinutes,
        skills: {
          create: data.skills.map((skill) => ({
            level: skill.level,
            skill: { connect: { id: skill.skillId } },
          })),
        },
        availability: { create: data.availability },
      },
      include: {
        skills: { include: { skill: true } },
        availability: true,
      },
    });

    return response.status(201).json(employee);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return response.status(409).json({
        code: "EMAIL_ALREADY_EXISTS",
        message: "An employee with this email already exists",
      });
    }

    console.error(error);

    return response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  }
});

employeeRouter.patch("/:id", async (request, response) => {
  const idResult = employeeIdSchema.safeParse(request.params.id);
  const bodyResult = updateEmployeeSchema.safeParse(request.body);

  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid employee data",
      errors: bodyResult.success ? [] : bodyResult.error.issues,
    });
  }

  try {
    const updateData: Prisma.EmployeeUpdateInput = {};
    if (bodyResult.data.name !== undefined) updateData.name = bodyResult.data.name;
    if (bodyResult.data.email !== undefined) updateData.email = bodyResult.data.email;
    if (bodyResult.data.role !== undefined) updateData.role = bodyResult.data.role;
    if (bodyResult.data.hourlyCostCents !== undefined) {
      updateData.hourlyCostCents = bodyResult.data.hourlyCostCents;
    }
    if (bodyResult.data.overtimeRateBasisPoints !== undefined) {
      updateData.overtimeRateBasisPoints = bodyResult.data.overtimeRateBasisPoints;
    }

    const employee = await prisma.employee.update({
      where: { id: idResult.data },
      data: updateData,
      include: {
        skills: { include: { skill: true } },
        availability: true,
      },
    });
    return response.json(employee);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2025"
    ) {
      return response.status(404).json({
        code: "EMPLOYEE_NOT_FOUND",
        message: "Employee does not exist",
      });
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2002"
    ) {
      return response.status(409).json({
        code: "EMAIL_ALREADY_EXISTS",
        message: "An employee with this email already exists",
      });
    }

    throw error;
  }
});

employeeRouter.post("/:id/archive", async (request, response) => {
  const idResult = employeeIdSchema.safeParse(request.params.id);
  const bodyResult = archiveEmployeeSchema.safeParse(request.body);

  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid archive request",
    });
  }

  const employeeId = idResult.data;
  const futureAllocations = await prisma.shift.count({
    where: {
      employeeId,
      status: "COMMITTED",
      startAt: { gte: new Date() },
    },
  });

  if (futureAllocations > 0 && !bodyResult.data.cancelFutureAllocations) {
    return response.status(409).json({
      code: "EMPLOYEE_HAS_FUTURE_ALLOCATIONS",
      message: "Cancel future allocations explicitly before archiving",
      futureAllocations,
    });
  }

  try {
    const archivedAt = new Date();
    const employee = await prisma.$transaction(async (transaction) => {
      if (bodyResult.data.cancelFutureAllocations) {
        await transaction.shift.updateMany({
          where: {
            employeeId,
            status: "COMMITTED",
            startAt: { gte: archivedAt },
          },
          data: { status: "CANCELLED", cancelledAt: archivedAt },
        });
      }

      return transaction.employee.update({
        where: { id: employeeId },
        data: {
          archivedAt,
          archiveReason: bodyResult.data.reason,
        },
      });
    });

    return response.json(employee);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2025"
    ) {
      return response.status(404).json({
        code: "EMPLOYEE_NOT_FOUND",
        message: "Employee does not exist",
      });
    }
    throw error;
  }
});

employeeRouter.post("/:id/restore", async (request, response) => {
  const idResult = employeeIdSchema.safeParse(request.params.id);

  if (!idResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid employee id",
    });
  }

  try {
    const employee = await prisma.employee.update({
      where: { id: idResult.data },
      data: { archivedAt: null, archiveReason: null },
    });
    return response.json(employee);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2025"
    ) {
      return response.status(404).json({
        code: "EMPLOYEE_NOT_FOUND",
        message: "Employee does not exist",
      });
    }
    throw error;
  }
});

employeeRouter.delete("/:id", async (request, response) => {
  const idResult = employeeIdSchema.safeParse(request.params.id);

  if (!idResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid employee id",
    });
  }

  const employee = await prisma.employee.findUnique({
    where: { id: idResult.data },
    select: {
      id: true,
      _count: { select: { shifts: true, workLogs: true } },
    },
  });

  if (!employee) {
    return response.status(404).json({
      code: "EMPLOYEE_NOT_FOUND",
      message: "Employee does not exist",
    });
  }

  if (employee._count.shifts > 0 || employee._count.workLogs > 0) {
    return response.status(409).json({
      code: "EMPLOYEE_HAS_HISTORY",
      message: "Employee cannot be deleted; archive instead",
      canArchive: true,
    });
  }

  await prisma.employee.delete({ where: { id: employee.id } });
  return response.status(204).send();
});
