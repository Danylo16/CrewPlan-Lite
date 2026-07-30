import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import type { Project } from "../types";

interface ProjectForm {
  name: string;
  color: string;
}

const initialForm: ProjectForm = {
  name: "",
  color: "#5267DF",
};

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState<ProjectForm>(initialForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadProjects() {
      try {
        const data = await apiRequest<Project[]>("/projects");
        setProjects(data);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load projects",
        );
      } finally {
        setIsLoading(false);
      }
    }

    void loadProjects();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const project = await apiRequest<Project>("/projects", {
        method: "POST",
        body: JSON.stringify(form),
      });

      setProjects((currentProjects) => [
        project,
        ...currentProjects,
      ]);

      setForm(initialForm);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to create project",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <h2>Projects</h2>
          <p>Create projects and assign a recognizable calendar color.</p>
        </div>

        <span className="count-badge">
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </span>
      </div>

      <div className="content-grid">
        <form className="panel form-panel" onSubmit={handleSubmit}>
          <h3>Add project</h3>

          <label>
            Project name
            <input
              type="text"
              value={form.name}
              placeholder="Customer Portal"
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
            Calendar color
            <div className="color-field">
              <input
                type="color"
                value={form.color}
                aria-label="Project color"
                onChange={(event) =>
                  setForm({
                    ...form,
                    color: event.target.value.toUpperCase(),
                  })
                }
              />

              <input
                type="text"
                value={form.color}
                pattern="^#[0-9A-Fa-f]{6}$"
                required
                onChange={(event) =>
                  setForm({
                    ...form,
                    color: event.target.value,
                  })
                }
              />
            </div>
          </label>

          {error && <div className="error-message">{error}</div>}

          <button className="primary-button" disabled={isSubmitting}>
            {isSubmitting ? "Adding…" : "Add project"}
          </button>
        </form>

        <div className="panel">
          <h3>Active projects</h3>

          {isLoading && <p className="muted-text">Loading projects…</p>}

          {!isLoading && projects.length === 0 && (
            <div className="empty-state">
              <strong>No projects yet</strong>
              <p>Add the first project using the form.</p>
            </div>
          )}

          <div className="project-grid">
            {projects.map((project) => (
              <article className="project-card" key={project.id}>
                <div
                  className="project-color"
                  style={{ backgroundColor: project.color }}
                />

                <div>
                  <strong>{project.name}</strong>
                  <p>{project.color}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}