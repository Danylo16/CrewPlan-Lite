import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export const employeeRouter = Router();

const createEmployeeSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().toLowerCase(),
  role: z.string().trim().min(2).max(100),
});

employeeRouter.get("/", async (_request, response) => {
  const employees = await prisma.employee.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });

  response.json(employees);
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
    const employee = await prisma.employee.create({
      data: validationResult.data,
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