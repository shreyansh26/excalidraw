import fs from "node:fs/promises";
import path from "node:path";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const PROJECTS_DIR = process.env.EXCALIDRAW_PROJECTS_DIR
  ? path.resolve(process.env.EXCALIDRAW_PROJECTS_DIR)
  : path.resolve(__dirname, "../../../excalidraw-projects");
const PROJECT_EXT = ".excalidraw";
const PROJECT_API_PREFIX = "/api/local-projects";

type LocalProjectResponse = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

const normalizeProjectId = (value: string) =>
  value.replace(INVALID_FILENAME_CHARS, "-").replace(/\s+/g, " ").trim();

const getProjectFilePath = (projectId: string) =>
  path.join(PROJECTS_DIR, `${projectId}${PROJECT_EXT}`);

const sendJson = (
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, any>,
) => {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
};

const readBody = async (req: IncomingMessage) => {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  if (!body) {
    return {};
  }
  return JSON.parse(body);
};

const ensureProjectsDir = async () => {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
};

const getProjectIdFromFileName = (fileName: string) => {
  return fileName.endsWith(PROJECT_EXT)
    ? fileName.slice(0, -PROJECT_EXT.length)
    : fileName;
};

const readProjectNameFromFile = async (filePath: string, fallback: string) => {
  try {
    const serialized = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(serialized) as {
      appState?: { name?: unknown };
    };
    if (
      typeof parsed.appState?.name === "string" &&
      parsed.appState.name.trim()
    ) {
      return parsed.appState.name.trim();
    }
  } catch {
    // keep fallback
  }
  return fallback;
};

const readProjectFromFile = async (
  fileName: string,
): Promise<LocalProjectResponse> => {
  const id = getProjectIdFromFileName(fileName);
  const filePath = getProjectFilePath(id);
  const [stats, name] = await Promise.all([
    fs.stat(filePath),
    readProjectNameFromFile(filePath, id),
  ]);

  return {
    id,
    name,
    createdAt: stats.birthtimeMs || stats.ctimeMs,
    updatedAt: stats.mtimeMs,
  };
};

const listProjectFiles = async () => {
  await ensureProjectsDir();
  const files = await fs.readdir(PROJECTS_DIR);
  return files.filter((fileName) => fileName.endsWith(PROJECT_EXT));
};

const findExistingProjectFile = async (projectId: string) => {
  const normalized = normalizeProjectId(projectId).toLocaleLowerCase();
  const files = await listProjectFiles();
  const match = files.find(
    (fileName) =>
      getProjectIdFromFileName(fileName).toLocaleLowerCase() === normalized,
  );
  return match ?? null;
};

const defaultProjectSerialized = (name: string) =>
  JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "local-projects-api",
      elements: [],
      appState: {
        name,
      },
      files: {},
    },
    null,
    2,
  );

export const localProjectsApiPlugin = (): Plugin => {
  return {
    name: "local-projects-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith(PROJECT_API_PREFIX)) {
          return next();
        }

        try {
          const url = new URL(req.url, "http://localhost");
          const method = (req.method || "GET").toUpperCase();
          const pathName = url.pathname;
          const subPath = pathName.slice(PROJECT_API_PREFIX.length);
          const segments = subPath.split("/").filter(Boolean);

          if (method === "GET" && segments.length === 0) {
            const files = await listProjectFiles();
            const projects = await Promise.all(
              files.map((fileName) => readProjectFromFile(fileName)),
            );
            projects.sort((a, b) => b.updatedAt - a.updatedAt);
            return sendJson(res, 200, { projects });
          }

          if (method === "POST" && segments.length === 0) {
            const body = (await readBody(req)) as {
              name?: string;
              serialized?: string;
            };
            const rawName = typeof body.name === "string" ? body.name : "";
            const normalizedName = normalizeProjectId(rawName);
            if (!normalizedName) {
              return sendJson(res, 400, { error: "Project name is required." });
            }

            const duplicate = await findExistingProjectFile(normalizedName);
            if (duplicate) {
              return sendJson(res, 409, {
                error: "Project name already exists.",
              });
            }

            await ensureProjectsDir();
            const filePath = getProjectFilePath(normalizedName);
            await fs.writeFile(
              filePath,
              body.serialized || defaultProjectSerialized(normalizedName),
              "utf8",
            );

            const project = await readProjectFromFile(
              `${normalizedName}${PROJECT_EXT}`,
            );
            return sendJson(res, 200, { project });
          }

          if (segments.length >= 1) {
            const projectIdFromUrl = decodeURIComponent(segments[0]);
            const existingFileName = await findExistingProjectFile(
              projectIdFromUrl,
            );

            if (!existingFileName) {
              return sendJson(res, 404, { error: "Project not found." });
            }

            const existingProjectId =
              getProjectIdFromFileName(existingFileName);
            const existingFilePath = getProjectFilePath(existingProjectId);

            if (method === "GET" && segments.length === 1) {
              const [project, serialized] = await Promise.all([
                readProjectFromFile(existingFileName),
                fs.readFile(existingFilePath, "utf8"),
              ]);
              return sendJson(res, 200, { project, serialized });
            }

            if (
              method === "POST" &&
              segments.length === 2 &&
              segments[1] === "snapshot"
            ) {
              const body = (await readBody(req)) as { serialized?: string };
              if (typeof body.serialized !== "string" || !body.serialized) {
                return sendJson(res, 400, {
                  error: "Serialized scene is required.",
                });
              }

              await fs.writeFile(existingFilePath, body.serialized, "utf8");
              const project = await readProjectFromFile(existingFileName);
              return sendJson(res, 200, {
                project,
                serialized: body.serialized,
              });
            }

            if (
              method === "POST" &&
              segments.length === 2 &&
              segments[1] === "rename"
            ) {
              const body = (await readBody(req)) as { name?: string };
              const rawName = typeof body.name === "string" ? body.name : "";
              const normalizedName = normalizeProjectId(rawName);

              if (!normalizedName) {
                return sendJson(res, 400, {
                  error: "Project name is required.",
                });
              }

              const duplicate = await findExistingProjectFile(normalizedName);
              if (
                duplicate &&
                getProjectIdFromFileName(duplicate).toLocaleLowerCase() !==
                  existingProjectId.toLocaleLowerCase()
              ) {
                return sendJson(res, 409, {
                  error: "Project name already exists.",
                });
              }

              if (normalizedName !== existingProjectId) {
                await fs.rename(
                  existingFilePath,
                  getProjectFilePath(normalizedName),
                );
              }
              const nextFileName = `${normalizedName}${PROJECT_EXT}`;
              const project = await readProjectFromFile(nextFileName);
              return sendJson(res, 200, { project });
            }

            if (method === "DELETE" && segments.length === 1) {
              await fs.rm(existingFilePath, { force: true });
              return sendJson(res, 200, { success: true });
            }
          }

          return sendJson(res, 404, { error: "Not found." });
        } catch (error) {
          console.error(error);
          return sendJson(res, 500, { error: "Local project API failed." });
        }
      });
    },
  };
};
