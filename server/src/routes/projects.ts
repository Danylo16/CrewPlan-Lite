import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

export const projectRouter = Router();

const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(100),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Color must be a valid hex value")
    .default("#6366F1"),
});

projectRouter.get("/", async (_request, response) => {
  const projects = await prisma.project.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });

  response.json(projects);
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

    return response.status(201).json(project);
  } catch (error) {
    console.error(error);

    return response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  }
});