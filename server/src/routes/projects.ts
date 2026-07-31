import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export const projectRouter = Router();

const projectNameSchema = z.string().trim().min(2).max(100);

const projectColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Color must be a valid hex value");

const createProjectSchema = z.object({
  name: projectNameSchema,
  color: projectColorSchema.default("#6366F1"),
});

const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    color: projectColorSchema.optional(),
  })
  .refine(
    (data) => data.name !== undefined || data.color !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

const projectIdSchema = z.coerce.number().int().positive();

projectRouter.get("/", async (_request, response) => {
  const projects = await prisma.project.findMany({
    include: {
      _count: {
        select: {
          shifts: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const result = projects.map(({ _count, ...project }) => ({
    ...project,
    shiftCount: _count.shifts,
  }));

  return response.json(result);
});

projectRouter.post("/", async (request, response) => {
  const validationResult = createProjectSchema.safeParse(request.body);

  if (!validationResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project data",
      errors: validationResult.error.issues,
    });
  }

  try {
    const project = await prisma.project.create({
      data: validationResult.data,
    });

    return response.status(201).json({
      ...project,
      shiftCount: 0,
    });
  } catch (error) {
    console.error(error);

    return response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  }
});

projectRouter.patch("/:id", async (request, response) => {
  const idResult = projectIdSchema.safeParse(request.params.id);
  const bodyResult = updateProjectSchema.safeParse(request.body);

  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project data",
    });
  }
  const updateData: Prisma.ProjectUpdateInput = {};

  if (bodyResult.data.name !== undefined) {
    updateData.name = bodyResult.data.name;
  }

  if (bodyResult.data.color !== undefined) {
    updateData.color = bodyResult.data.color;
  }

  try {
    const project = await prisma.project.update({
      where: {
        id: idResult.data,
      },
      data: updateData,
      include: {
        _count: {
          select: {
            shifts: true,
          },
        },
      },
    });

    const { _count, ...projectData } = project;

    return response.json({
      ...projectData,
      shiftCount: _count.shifts,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return response.status(404).json({
        code: "PROJECT_NOT_FOUND",
        message: "Project does not exist",
      });
    }

    console.error(error);

    return response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  }
});