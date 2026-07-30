import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import type { Employee } from "../types";

interface EmployeeForm {
  name: string;
  email: string;
  role: string;
}

const initialForm: EmployeeForm = {
  name: "",
  email: "",
  role: "",
};

export function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [form, setForm] = useState<EmployeeForm>(initialForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadEmployees() {
      try {
        const data = await apiRequest<Employee[]>("/employees");
        setEmployees(data);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load employees",
        );
      } finally {
        setIsLoading(false);
      }
    }

    void loadEmployees();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const employee = await apiRequest<Employee>("/employees", {
        method: "POST",
        body: JSON.stringify(form),
      });

      setEmployees((currentEmployees) => [
        employee,
        ...currentEmployees,
      ]);

      setForm(initialForm);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to create employee",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <h2>Employees</h2>
          <p>Manage employees available for project assignments.</p>
        </div>

        <span className="count-badge">
            {employees.length} {employees.length === 1 ? "employee" : "employees"}
        </span> 
      </div>

      <div className="content-grid">
        <form className="panel form-panel" onSubmit={handleSubmit}>
          <h3>Add employee</h3>

          <label>
            Name
            <input
              type="text"
              value={form.name}
              placeholder="Anna Müller"
              required
              minLength={2}
              onChange={(event) =>
                setForm({
                  ...form,
                  name: event.target.value,
                })
              }
            />
          </label>

          <label>
            Email
            <input
              type="email"
              value={form.email}
              placeholder="anna@company.at"
              required
              onChange={(event) =>
                setForm({
                  ...form,
                  email: event.target.value,
                })
              }
            />
          </label>

          <label>
            Role
            <input
              type="text"
              value={form.role}
              placeholder="Frontend Developer"
              required
              minLength={2}
              onChange={(event) =>
                setForm({
                  ...form,
                  role: event.target.value,
                })
              }
            />
          </label>

          {error && <div className="error-message">{error}</div>}

          <button className="primary-button" disabled={isSubmitting}>
            {isSubmitting ? "Adding…" : "Add employee"}
          </button>
        </form>

        <div className="panel">
          <h3>Team</h3>

          {isLoading && <p className="muted-text">Loading employees…</p>}

          {!isLoading && employees.length === 0 && (
            <div className="empty-state">
              <strong>No employees yet</strong>
              <p>Add the first employee using the form.</p>
            </div>
          )}

          <div className="item-list">
            {employees.map((employee) => (
              <article className="employee-card" key={employee.id}>
                <div className="employee-avatar">
                  {employee.name.charAt(0).toUpperCase()}
                </div>

                <div>
                  <strong>{employee.name}</strong>
                  <p>{employee.role}</p>
                  <span>{employee.email}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}