import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import type {
  Employee,
  Holiday,
  Project,
  Shift,
} from "../types";

interface ShiftForm {
  employeeId: string;
  projectId: string;
  startAt: string;
  endAt: string;
  note: string;
}

function startOfWeek(date: Date) {
  const result = new Date(date);
  const day = result.getDay();
  const difference = day === 0 ? -6 : 1 - day;

  result.setDate(result.getDate() + difference);
  result.setHours(0, 0, 0, 0);

  return result;
}

function addDays(date: Date, amount: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function toLocalInputValue(date: Date) {
  const timezoneOffset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - timezoneOffset)
    .toISOString()
    .slice(0, 16);
}

function createInitialForm(): ShiftForm {
  const start = new Date();
  start.setMinutes(0, 0, 0);

  const end = new Date(start);
  end.setHours(end.getHours() + 4);

  return {
    employeeId: "",
    projectId: "",
    startAt: toLocalInputValue(start),
    endAt: toLocalInputValue(end),
    note: "",
  };
}

function formatTime(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

export function SchedulePage() {
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date()),
  );

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [form, setForm] = useState<ShiftForm>(createInitialForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = Array.from({ length: 7 }, (_, index) =>
    addDays(weekStart, index),
  );

  const weekEnd = addDays(weekStart, 7);

  useEffect(() => {
    async function loadSchedule() {
      setIsLoading(true);
      setError(null);

      try {
        const from = encodeURIComponent(weekStart.toISOString());
        const to = encodeURIComponent(weekEnd.toISOString());

        const holidayFrom = toDateKey(weekStart);
const holidayTo = toDateKey(addDays(weekStart, 6));

const [
        employeeData,
        projectData,
        shiftData,
        holidayData,
      ] = await Promise.all([
  apiRequest<Employee[]>("/employees"),
  apiRequest<Project[]>("/projects"),
  apiRequest<Shift[]>(`/shifts?from=${from}&to=${to}`),
  apiRequest<Holiday[]>(
    `/holidays?from=${holidayFrom}&to=${holidayTo}`,
  ),
]); 

        setEmployees(employeeData);
        setProjects(projectData);
        setShifts(shiftData);
        setHolidays(holidayData);

        setForm((currentForm) => ({
          ...currentForm,
          employeeId:
            currentForm.employeeId ||
            String(employeeData[0]?.id ?? ""),
          projectId:
            currentForm.projectId ||
            String(projectData[0]?.id ?? ""),
        }));
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load schedule",
        );
      } finally {
        setIsLoading(false);
      }
    }

    void loadSchedule();
  }, [weekStart]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const shift = await apiRequest<Shift>("/shifts", {
        method: "POST",
        body: JSON.stringify({
          employeeId: Number(form.employeeId),
          projectId: Number(form.projectId),
          startAt: new Date(form.startAt).toISOString(),
          endAt: new Date(form.endAt).toISOString(),
          note: form.note || undefined,
        }),
      });

      setShifts((currentShifts) =>
        [...currentShifts, shift].sort(
          (first, second) =>
            new Date(first.startAt).getTime() -
            new Date(second.startAt).getTime(),
        ),
      );

      setForm((currentForm) => ({
        ...createInitialForm(),
        employeeId: currentForm.employeeId,
        projectId: currentForm.projectId,
      }));
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to create shift",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section>
      <div className="page-header schedule-header">
        <div>
          <h2>Schedule</h2>
          <p>Plan employee assignments and prevent overlapping shifts.</p>
        </div>

        <div className="week-navigation">
          <button
            type="button"
            onClick={() => setWeekStart(addDays(weekStart, -7))}
          >
            ←
          </button>

          <strong>
            {weekStart.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            })}
            {" – "}
            {addDays(weekStart, 6).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </strong>

          <button
            type="button"
            onClick={() => setWeekStart(addDays(weekStart, 7))}
          >
            →
          </button>

          <button
            type="button"
            className="today-button"
            onClick={() => setWeekStart(startOfWeek(new Date()))}
          >
            Today
          </button>
        </div>
      </div>

      <form className="panel shift-form" onSubmit={handleSubmit}>
        <label>
          Employee
          <select
            value={form.employeeId}
            required
            onChange={(event) =>
              setForm({
                ...form,
                employeeId: event.target.value,
              })
            }
          >
            <option value="">Select employee</option>

            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Project
          <select
            value={form.projectId}
            required
            onChange={(event) =>
              setForm({
                ...form,
                projectId: event.target.value,
              })
            }
          >
            <option value="">Select project</option>

            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Start
          <input
            type="datetime-local"
            value={form.startAt}
            required
            onChange={(event) =>
              setForm({
                ...form,
                startAt: event.target.value,
              })
            }
          />
        </label>

        <label>
          End
          <input
            type="datetime-local"
            value={form.endAt}
            required
            onChange={(event) =>
              setForm({
                ...form,
                endAt: event.target.value,
              })
            }
          />
        </label>

        <label>
          Note
          <input
            type="text"
            value={form.note}
            placeholder="Optional"
            maxLength={500}
            onChange={(event) =>
              setForm({
                ...form,
                note: event.target.value,
              })
            }
          />
        </label>

        <button
          className="primary-button shift-submit"
          disabled={
            isSubmitting ||
            employees.length === 0 ||
            projects.length === 0
          }
        >
          {isSubmitting ? "Creating…" : "Create shift"}
        </button>
      </form>

      {error && <div className="error-message schedule-error">{error}</div>}

      {isLoading ? (
        <p className="muted-text">Loading schedule…</p>
      ) : (
        <div className="calendar">
          {days.map((day) => {
            const dayShifts = shifts.filter((shift) => {
              const shiftDate = new Date(shift.startAt);

              return (
                shiftDate.getFullYear() === day.getFullYear() &&
                shiftDate.getMonth() === day.getMonth() &&
                shiftDate.getDate() === day.getDate()
              );
            });


            const dayHolidays = holidays.filter(
              (holiday) =>
                holiday.date === toDateKey(day) &&
                holiday.nationwide,
            );

            const isToday =
              day.toDateString() === new Date().toDateString();

            return (
              <div className="calendar-day" key={day.toISOString()}>
                <header className={isToday ? "today" : undefined}>
                  <span>
                    {day.toLocaleDateString("en-GB", {
                      weekday: "short",
                    })}
                  </span>

                  <strong>{day.getDate()}</strong>
                </header>

                {dayHolidays.map((holiday) => (
                  <div className="holiday-label" key={holiday.id}>
                    <span>Public holiday</span>
                    <strong>{holiday.name}</strong>
                  </div>
                ))}

                <div className="day-shifts">
                  {dayShifts.length === 0 && (
                    <span className="no-shifts">No shifts</span>
                  )}

                  {dayShifts.map((shift) => (
                    <article
                      className="shift-card"
                      key={shift.id}
                      style={{
                        borderLeftColor: shift.project.color,
                      }}
                    >
                      <strong>{shift.project.name}</strong>

                      <span>
                        {formatTime(shift.startAt)}
                        {" – "}
                        {formatTime(shift.endAt)}
                      </span>

                      <p>{shift.employee.name}</p>

                      {shift.note && <small>{shift.note}</small>}
                    </article>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
} 