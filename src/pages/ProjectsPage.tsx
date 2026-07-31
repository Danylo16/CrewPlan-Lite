import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import type { ProjectWithCount } from "../types";

interface ProjectForm {
  name: string;
  color: string;
}

const initialForm: ProjectForm = {
  name: "",
  color: "#5267DF",
};

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectWithCount[]>([]);
  const [form, setForm] = useState<ProjectForm>(initialForm);
  const [editingProject, setEditingProject] =
    useState<ProjectWithCount | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalAssignments = projects.reduce(
    (total, project) => total + project.shiftCount,
    0,
  );

  useEffect(() => {
    async function loadProjects() {
      try {
        const data =
          await apiRequest<ProjectWithCount[]>("/projects");

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

  function openCreateModal() {
    setEditingProject(null);
    setForm(initialForm);
    setError(null);
    setIsModalOpen(true);
  }

  function openEditModal(project: ProjectWithCount) {
    setEditingProject(project);
    setForm({
      name: project.name,
      color: project.color,
    });
    setError(null);
    setIsModalOpen(true);
  }

  function closeModal() {
     

    setIsModalOpen(false);
    setEditingProject(null);
    setForm(initialForm);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const project = await apiRequest<ProjectWithCount>(
        editingProject
          ? `/projects/${editingProject.id}`
          : "/projects",
        {
          method: editingProject ? "PATCH" : "POST",
          body: JSON.stringify(form),
        },
      );

      setProjects((currentProjects) =>
        editingProject
          ? currentProjects.map((currentProject) =>
              currentProject.id === project.id
                ? project
                : currentProject,
            )
          : [project, ...currentProjects],
      );

      closeModal();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save project",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section>
      <div className="page-header projects-header">
        <div>
          <h2>Projects</h2>
          <p>Manage workstreams and their calendar identity.</p>
        </div>

        <button
          className="primary-button header-button"
          type="button"
          onClick={openCreateModal}
        >
          + New project
        </button>
      </div>

      <div className="project-stats">
        <div className="stat-card">
          <span>Active projects</span>
          <strong>{projects.length}</strong>
        </div>

        <div className="stat-card">
          <span>Scheduled shifts</span>
          <strong>{totalAssignments}</strong>
        </div>
      </div>

      {error && !isModalOpen && (
        <div className="error-message">{error}</div>
      )}

      {isLoading ? (
        <p className="muted-text">Loading projects…</p>
      ) : projects.length === 0 ? (
        <div className="panel projects-empty">
          <strong>No projects yet</strong>
          <p>Create your first project to begin scheduling work.</p>

          <button
            className="primary-button"
            type="button"
            onClick={openCreateModal}
          >
            Create project
          </button>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map((project) => (
            <article className="project-tile" key={project.id}>
              <div
                className="project-tile-accent"
                style={{ backgroundColor: project.color }}
              />

              <div className="project-tile-header">
                <div
                  className="project-icon"
                  style={{
                    color: project.color,
                    backgroundColor: `${project.color}18`,
                  }}
                >
                  {project.name.charAt(0).toUpperCase()}
                </div>

                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => openEditModal(project)}
                >
                  Edit
                </button>
              </div>

              <div className="project-tile-content">
                <h3>{project.name}</h3>
                <p>
                  {project.shiftCount}{" "}
                  {project.shiftCount === 1
                    ? "scheduled shift"
                    : "scheduled shifts"}
                </p>
              </div>

              <div className="project-tile-footer">
                <span
                  className="color-dot"
                  style={{ backgroundColor: project.color }}
                />
                <span>Calendar color</span>
              </div>
            </article>
          ))}
        </div>
      )}

      {isModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={closeModal}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h3 id="project-modal-title">
                  {editingProject ? "Edit project" : "New project"}
                </h3>
                <p>
                  {editingProject
                    ? "Update the project name or calendar color."
                    : "Create a workstream for employee assignments."}
                </p>
              </div>

              <button
                className="modal-close"
                type="button"
                aria-label="Close"
                onClick={closeModal}
              >
                ×
              </button>
            </div>

            <form className="modal-form" onSubmit={handleSubmit}>
              <label>
                Project name
                <input
                  type="text"
                  value={form.name}
                  placeholder="Customer Portal"
                  required
                  minLength={2}
                  maxLength={100}
                  autoFocus
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
                <div className="modal-color-field">
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

              <div
                className="color-preview"
                style={{
                  borderLeftColor: form.color,
                  backgroundColor: `${form.color}10`,
                }}
              >
                <strong>{form.name || "Project preview"}</strong>
                <span>This color will identify shifts in the calendar.</span>
              </div>

              {error && (
                <div className="error-message">{error}</div>
              )}

              <div className="modal-actions">
                <button
                  className="secondary-button modal-action"
                  type="button"
                  onClick={closeModal}
                >
                  Cancel
                </button>

                <button
                  className="primary-button modal-action"
                  disabled={isSubmitting}
                >
                  {isSubmitting
                    ? "Saving…"
                    : editingProject
                      ? "Save changes"
                      : "Create project"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}