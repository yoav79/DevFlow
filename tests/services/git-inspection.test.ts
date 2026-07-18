import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

import { inspectGitRepository, GitInspectionError } from "../../src/services/git-inspection.js";
import { createTempGitRepository } from "../helpers/temp-git-repository.js";
import { createTempDirectory } from "../helpers/temp-directory.js";

describe("git inspection", () => {
  describe("validación de ruta", () => {
    it("lanza error para ruta vacía", () => {
      try {
        inspectGitRepository("");
        throw new Error("Expected GitInspectionError.");
      } catch (error) {
        expect(error).toBeInstanceOf(GitInspectionError);
        expect((error as GitInspectionError).message).toBe("La ruta del repositorio no puede estar vacía.");
        expect((error as GitInspectionError).repositoryPath).toBe("");
      }
    });

    it("lanza error para ruta con solo espacios", () => {
      try {
        inspectGitRepository("   ");
        throw new Error("Expected GitInspectionError.");
      } catch (error) {
        expect(error).toBeInstanceOf(GitInspectionError);
        expect((error as GitInspectionError).message).toBe("La ruta del repositorio no puede estar vacía.");
      }
    });

    it("lanza error para ruta inexistente", () => {
      const path = "/tmp/devflow-nonexistent-12345";
      try {
        inspectGitRepository(path);
        throw new Error("Expected GitInspectionError.");
      } catch (error) {
        expect(error).toBeInstanceOf(GitInspectionError);
        expect((error as GitInspectionError).message).toContain("No existe la ruta del repositorio:");
        expect((error as GitInspectionError).repositoryPath).toBe(path);
      }
    });

    it("lanza error cuando la ruta es un archivo", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        const filePath = join(dir.path, "file.txt");
        writeFileSync(filePath, "content");
        try {
          inspectGitRepository(filePath);
          throw new Error("Expected GitInspectionError.");
        } catch (error) {
          expect(error).toBeInstanceOf(GitInspectionError);
          expect((error as GitInspectionError).message).toContain("La ruta del repositorio no es un directorio:");
          expect((error as GitInspectionError).repositoryPath).toBe(filePath);
        }
      } finally {
        dir.cleanup();
      }
    });
  });

  describe("repositorio válido", () => {
    it("detecta un repositorio Git válido", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.repositoryRoot).toBeDefined();
        expect(result.baseCommit).toBeDefined();
      } finally {
        repo.cleanup();
      }
    });

    it("repositoryRoot es una ruta absoluta", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.repositoryRoot.startsWith("/")).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("baseCommit tiene 40 caracteres hexadecimales", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.baseCommit).toHaveLength(40);
        expect(/^[0-9a-f]{40}$/.test(result.baseCommit)).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("baseCommit está en minúsculas", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.baseCommit).toBe(result.baseCommit.toLowerCase());
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("raíz del repositorio", () => {
    it("acepta ruta al root del repositorio", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.repositoryRoot).toBe(repo.path);
      } finally {
        repo.cleanup();
      }
    });

    it("acepta ruta a subdirectorio", () => {
      const repo = createTempGitRepository();
      try {
        const subdir = join(repo.path, "subdir");
        mkdirSync(subdir);
        const result = inspectGitRepository(subdir);
        expect(result.repositoryRoot).toBe(repo.path);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("directorio no Git", () => {
    it("lanza error para directorio que no es repositorio", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        try {
          inspectGitRepository(dir.path);
          throw new Error("Expected GitInspectionError.");
        } catch (error) {
          expect(error).toBeInstanceOf(GitInspectionError);
          expect((error as GitInspectionError).message).toContain("La ruta no corresponde a un repositorio Git válido:");
        }
      } finally {
        dir.cleanup();
      }
    });
  });

  describe("repo sin commits", () => {
    it("lanza error cuando no hay HEAD válido", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        const { spawnSync } = require("node:child_process");
        spawnSync("git", ["init"], { cwd: dir.path, encoding: "utf8" });
        try {
          inspectGitRepository(dir.path);
          throw new Error("Expected GitInspectionError.");
        } catch (error) {
          expect(error).toBeInstanceOf(GitInspectionError);
          expect((error as GitInspectionError).message).toContain("El repositorio no tiene un commit HEAD válido:");
        }
      } finally {
        dir.cleanup();
      }
    });
  });

  describe("repo bare", () => {
    it("trata repo bare como no válido", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        const { spawnSync } = require("node:child_process");
        spawnSync("git", ["init", "--bare"], { cwd: dir.path, encoding: "utf8" });
        try {
          inspectGitRepository(dir.path);
          throw new Error("Expected GitInspectionError.");
        } catch (error) {
          expect(error).toBeInstanceOf(GitInspectionError);
          expect((error as GitInspectionError).message).toContain("La ruta no corresponde a un repositorio Git válido:");
        }
      } finally {
        dir.cleanup();
      }
    });
  });

  describe("conservación de repositoryPath", () => {
    it("conserva repositoryPath en error de ruta vacía", () => {
      try {
        inspectGitRepository("");
        throw new Error("Expected GitInspectionError.");
      } catch (error) {
        expect((error as GitInspectionError).repositoryPath).toBe("");
      }
    });

    it("conserva repositoryPath en error de ruta inexistente", () => {
      const path = "/tmp/devflow-nonexistent-12345";
      try {
        inspectGitRepository(path);
        throw new Error("Expected GitInspectionError.");
      } catch (error) {
        expect((error as GitInspectionError).repositoryPath).toBe(path);
      }
    });
  });

  describe("conservación de command", () => {
    it("conserva command en error de repo no válido", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        try {
          inspectGitRepository(dir.path);
          throw new Error("Expected GitInspectionError.");
        } catch (error) {
          expect((error as GitInspectionError).command).toBe("rev-parse --show-toplevel");
        }
      } finally {
        dir.cleanup();
      }
    });

    it("conserva command en error de HEAD inválido", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        const { spawnSync } = require("node:child_process");
        spawnSync("git", ["init"], { cwd: dir.path, encoding: "utf8" });
        try {
          inspectGitRepository(dir.path);
          throw new Error("Expected GitInspectionError.");
        } catch (error) {
          expect((error as GitInspectionError).command).toBe("rev-parse --verify HEAD");
        }
      } finally {
        dir.cleanup();
      }
    });
  });

  describe("conservación de exitCode", () => {
    it("conserva exitCode en error de repo no válido", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        try {
          inspectGitRepository(dir.path);
          throw new Error("Expected GitInspectionError.");
        } catch (error) {
          expect((error as GitInspectionError).exitCode).toBeDefined();
          expect((error as GitInspectionError).exitCode).not.toBe(0);
        }
      } finally {
        dir.cleanup();
      }
    });
  });

  describe("GitInspectionError", () => {
    it("extiende Error", () => {
      const error = new GitInspectionError("test", { repositoryPath: "/tmp" });
      expect(error).toBeInstanceOf(Error);
    });

    it("name es GitInspectionError", () => {
      const error = new GitInspectionError("test", { repositoryPath: "/tmp" });
      expect(error.name).toBe("GitInspectionError");
    });

    it("conserva cause", () => {
      const cause = new Error("original");
      const error = new GitInspectionError("test", { repositoryPath: "/tmp", cause });
      expect(error.cause).toBe(cause);
    });
  });

  describe("solo lectura", () => {
    it("no cambia HEAD", () => {
      const repo = createTempGitRepository();
      try {
        const headBefore = repo.runGit(["rev-parse", "HEAD"]);
        inspectGitRepository(repo.path);
        const headAfter = repo.runGit(["rev-parse", "HEAD"]);
        expect(headAfter).toBe(headBefore);
      } finally {
        repo.cleanup();
      }
    });

    it("no cambia la rama actual", () => {
      const repo = createTempGitRepository();
      try {
        const branchBefore = repo.runGit(["branch", "--show-current"]);
        inspectGitRepository(repo.path);
        const branchAfter = repo.runGit(["branch", "--show-current"]);
        expect(branchAfter).toBe(branchBefore);
      } finally {
        repo.cleanup();
      }
    });

    it("no cambia git status", () => {
      const repo = createTempGitRepository();
      try {
        const statusBefore = repo.runGit(["status", "--short"]);
        inspectGitRepository(repo.path);
        const statusAfter = repo.runGit(["status", "--short"]);
        expect(statusAfter).toBe(statusBefore);
      } finally {
        repo.cleanup();
      }
    });

    it("no crea commits", () => {
      const repo = createTempGitRepository();
      try {
        const countBefore = repo.runGit(["rev-list", "--count", "HEAD"]);
        inspectGitRepository(repo.path);
        const countAfter = repo.runGit(["rev-list", "--count", "HEAD"]);
        expect(countAfter).toBe(countBefore);
      } finally {
        repo.cleanup();
      }
    });

    it("no crea ramas", () => {
      const repo = createTempGitRepository();
      try {
        const branchesBefore = repo.runGit(["branch"]);
        inspectGitRepository(repo.path);
        const branchesAfter = repo.runGit(["branch"]);
        expect(branchesAfter).toBe(branchesBefore);
      } finally {
        repo.cleanup();
      }
    });

    it("no crea worktrees", () => {
      const repo = createTempGitRepository();
      try {
        const worktreesBefore = repo.runGit(["worktree", "list"]);
        inspectGitRepository(repo.path);
        const worktreesAfter = repo.runGit(["worktree", "list"]);
        expect(worktreesAfter).toBe(worktreesBefore);
      } finally {
        repo.cleanup();
      }
    });

    it("no modifica archivos", () => {
      const repo = createTempGitRepository();
      try {
        const readmeBefore = repo.runGit(["show", "HEAD:README.md"]);
        inspectGitRepository(repo.path);
        const readmeAfter = repo.runGit(["show", "HEAD:README.md"]);
        expect(readmeAfter).toBe(readmeBefore);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("determinismo", () => {
    it("inspecciones consecutivas son deterministas", () => {
      const repo = createTempGitRepository();
      try {
        const first = inspectGitRepository(repo.path);
        const second = inspectGitRepository(repo.path);
        expect(first.repositoryRoot).toBe(second.repositoryRoot);
        expect(first.baseCommit).toBe(second.baseCommit);
      } finally {
        repo.cleanup();
      }
    });

    it("un nuevo commit cambia baseCommit", () => {
      const repo = createTempGitRepository();
      try {
        const before = inspectGitRepository(repo.path);
        writeFileSync(join(repo.path, "new-file.txt"), "new content");
        repo.runGit(["add", "new-file.txt"]);
        repo.runGit(["commit", "-m", "second commit"]);
        const after = inspectGitRepository(repo.path);
        expect(after.baseCommit).not.toBe(before.baseCommit);
      } finally {
        repo.cleanup();
      }
    });

    it("repositoryRoot permanece estable después de commit", () => {
      const repo = createTempGitRepository();
      try {
        const before = inspectGitRepository(repo.path);
        writeFileSync(join(repo.path, "new-file.txt"), "new content");
        repo.runGit(["add", "new-file.txt"]);
        repo.runGit(["commit", "-m", "second commit"]);
        const after = inspectGitRepository(repo.path);
        expect(after.repositoryRoot).toBe(before.repositoryRoot);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("estructura del resultado", () => {
    it("resultado contiene únicamente repositoryRoot y baseCommit", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        const keys = Object.keys(result);
        expect(keys).toEqual(["repositoryRoot", "baseCommit"]);
      } finally {
        repo.cleanup();
      }
    });

    it("repositoryRoot es string", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(typeof result.repositoryRoot).toBe("string");
      } finally {
        repo.cleanup();
      }
    });

    it("baseCommit es string", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(typeof result.baseCommit).toBe("string");
      } finally {
        repo.cleanup();
      }
    });
  });
});
