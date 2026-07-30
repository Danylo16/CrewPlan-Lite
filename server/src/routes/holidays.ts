import { Router } from "express";
import { z } from "zod";

export const holidayRouter = Router();

const holidayQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

interface OpenHolidayName {
  language: string;
  text: string;
}

interface OpenHoliday {
  id: string;
  startDate: string;
  endDate: string;
  name: OpenHolidayName[];
  nationwide: boolean;
}

holidayRouter.get("/", async (request, response) => {
  const validationResult = holidayQuerySchema.safeParse(request.query);

  if (!validationResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Dates must use YYYY-MM-DD format",
      errors: validationResult.error.issues,
    });
  }

  const { from, to } = validationResult.data;

  const parameters = new URLSearchParams({
    countryIsoCode: "AT",
    languageIsoCode: "EN",
    validFrom: from,
    validTo: to,
  });

  try {
    const holidayResponse = await fetch(
      `https://openholidaysapi.org/PublicHolidays?${parameters}`,
      {
        headers: {
          Accept: "text/json",
        },
      },
    );

    if (!holidayResponse.ok) {
      throw new Error(
        `OpenHolidays returned ${holidayResponse.status}`,
      );
    }

    const holidays = (await holidayResponse.json()) as OpenHoliday[];

    const result = holidays.map((holiday) => ({
      id: holiday.id,
      date: holiday.startDate,
      endDate: holiday.endDate,
      name:
        holiday.name.find(
          (translation) =>
            translation.language.toUpperCase() === "EN",
        )?.text ??
        holiday.name[0]?.text ??
        "Public holiday",
      nationwide: holiday.nationwide,
    }));

    return response.json(result);
  } catch (error) {
    console.error("OpenHolidays API error:", error);

    return response.status(502).json({
      code: "HOLIDAY_SERVICE_UNAVAILABLE",
      message: "Public holiday service is temporarily unavailable",
    });
  }
});