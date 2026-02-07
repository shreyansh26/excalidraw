import { useMemo, useState } from "react";

import { DuplicateProjectNameError } from "../data/ProjectStore";

import "./ProjectManagerPage.scss";

import type { ProjectMetadata } from "../data/ProjectStore";

type ProjectManagerPageProps = {
  projects: ProjectMetadata[];
  onCreateProject: (name: string) => Promise<void>;
  onOpenProject: (projectId: string) => Promise<void>;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
};

const formatDate = (timestamp: number) => {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof DuplicateProjectNameError) {
    return "Project name already exists.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong.";
};

export const ProjectManagerPage = ({
  projects,
  onCreateProject,
  onOpenProject,
  onRenameProject,
  onDeleteProject,
}: ProjectManagerPageProps) => {
  const [newProjectName, setNewProjectName] = useState("");
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState("");
  const [editError, setEditError] = useState("");
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);

  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [projects]);

  const startRename = (project: ProjectMetadata) => {
    setEditError("");
    setEditingProjectId(project.id);
    setEditingProjectName(project.name);
  };

  const resetRename = () => {
    setEditingProjectId(null);
    setEditingProjectName("");
    setEditError("");
  };

  return (
    <div className="project-manager-page">
      <div className="project-manager-page__container">
        <header className="project-manager-page__header">
          <h1>Projects</h1>
          <p>
            Each project keeps the latest snapshots as local .excalidraw data.
          </p>
        </header>

        <section className="project-manager-page__create">
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setCreateError("");
              setIsCreating(true);
              try {
                await onCreateProject(newProjectName);
                setNewProjectName("");
              } catch (error) {
                setCreateError(getErrorMessage(error));
              } finally {
                setIsCreating(false);
              }
            }}
          >
            <label htmlFor="new-project-name">New project name</label>
            <div className="project-manager-page__create-row">
              <input
                id="new-project-name"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder="App design board"
                autoComplete="off"
              />
              <button type="submit" disabled={isCreating}>
                {isCreating ? "Creating..." : "Create"}
              </button>
            </div>
            {createError && (
              <p className="project-manager-page__error" role="alert">
                {createError}
              </p>
            )}
          </form>
        </section>

        <section className="project-manager-page__list">
          {sortedProjects.length === 0 ? (
            <div className="project-manager-page__empty">
              No projects yet. Create one to start drawing.
            </div>
          ) : (
            sortedProjects.map((project) => {
              const isEditing = editingProjectId === project.id;
              const isBusy = busyProjectId === project.id;

              return (
                <article
                  key={project.id}
                  className="project-manager-page__item"
                >
                  <div className="project-manager-page__meta">
                    {isEditing ? (
                      <form
                        className="project-manager-page__rename-form"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          setBusyProjectId(project.id);
                          setEditError("");
                          try {
                            await onRenameProject(
                              project.id,
                              editingProjectName,
                            );
                            resetRename();
                          } catch (error) {
                            setEditError(getErrorMessage(error));
                          } finally {
                            setBusyProjectId(null);
                          }
                        }}
                      >
                        <input
                          value={editingProjectName}
                          onChange={(event) =>
                            setEditingProjectName(event.target.value)
                          }
                          autoFocus
                          autoComplete="off"
                        />
                        <div className="project-manager-page__actions">
                          <button type="submit" disabled={isBusy}>
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={resetRename}
                            disabled={isBusy}
                          >
                            Cancel
                          </button>
                        </div>
                        {editError && (
                          <p
                            className="project-manager-page__error"
                            role="alert"
                          >
                            {editError}
                          </p>
                        )}
                      </form>
                    ) : (
                      <>
                        <h2>{project.name}</h2>
                        <p>Updated: {formatDate(project.updatedAt)}</p>
                      </>
                    )}
                  </div>

                  {!isEditing && (
                    <div className="project-manager-page__actions">
                      <button
                        type="button"
                        onClick={async () => {
                          setBusyProjectId(project.id);
                          try {
                            await onOpenProject(project.id);
                          } finally {
                            setBusyProjectId(null);
                          }
                        }}
                        disabled={isBusy}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        onClick={() => startRename(project)}
                        disabled={isBusy}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="project-manager-page__danger"
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Delete "${project.name}" and all its local snapshots?`,
                            )
                          ) {
                            return;
                          }
                          setBusyProjectId(project.id);
                          try {
                            await onDeleteProject(project.id);
                          } finally {
                            setBusyProjectId(null);
                          }
                        }}
                        disabled={isBusy}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
};
