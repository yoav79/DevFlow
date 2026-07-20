import { describe, expect, it } from "vitest";

import {
  buildExecutorPrompt,
  ExecutorPromptBuildError,
  type ExecutorPromptInput,
} from "../../src/services/executor-prompt-builder.js";

type TestInputOverrides = {
  project?: Partial<ExecutorPromptInput["project"]>;
  task?: Partial<ExecutorPromptInput["task"]>;
  contract?: Partial<ExecutorPromptInput["contract"]>;
  workspace?: Partial<ExecutorPromptInput["workspace"]>;
};

function createInput(overrides: TestInputOverrides = {}): ExecutorPromptInput {
  return {
    project: {
      name: "Alpha",
      ...(overrides.project ?? {}),
    },
    task: {
      id: "TASK-001",
      title: "Implement feature",
      description: "Build the first slice",
      ...(overrides.task ?? {}),
    },
    contract: {
      objective: "Implement the approved feature.",
      context: "The release depends on this behavior.",
      acceptanceCriteria: ["Criterion 1"],
      allowedPaths: [],
      forbiddenPaths: [],
      requiredCommands: [],
      assumptions: [],
      risks: [],
      ...(overrides.contract ?? {}),
    },
    workspace: {
      workspacePath: "/tmp/devflow/worktree",
      branchName: "devflow/proj/task/execution-1",
      baseCommit: "abc123def456",
      executionNumber: 1,
      ...(overrides.workspace ?? {}),
    },
  };
}

function expectBuildError(
  fn: () => string,
  code: ExecutorPromptBuildError["code"],
  path: readonly (string | number)[],
): ExecutorPromptBuildError {
  try {
    fn();
    expect.fail("Should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutorPromptBuildError);
    const typed = error as ExecutorPromptBuildError;
    expect(typed.code).toBe(code);
    expect(typed.path).toEqual(path);
    expect(typed.name).toBe("ExecutorPromptBuildError");
    return typed;
  }
}

describe("buildExecutorPrompt", () => {
  it("returns a non-empty string for the minimum valid input", () => {
    const prompt = buildExecutorPrompt(createInput());

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same input", () => {
    const input = createInput();

    expect(buildExecutorPrompt(input)).toBe(buildExecutorPrompt(input));
  });

  it("keeps the fixed section order", () => {
    const prompt = buildExecutorPrompt(createInput());

    const sections = [
      "IDENTIDAD",
      "MISIÓN",
      "RESTRICCIONES OPERATIVAS",
      "CONTEXTO DE EJECUCIÓN",
      "CONTRATO APROBADO",
      "CONTRATO DEL AGENT ENVELOPE",
      "PAYLOAD DEL EXECUTOR",
      "REGLAS DE STATUS",
      "REGLA FINAL DE RESPUESTA",
    ];

    let lastIndex = -1;
    for (const section of sections) {
      const index = prompt.indexOf(section);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("serializes the execution context as JSON", () => {
    const input = createInput({
      project: { name: 'Alpha "Repo"' },
      task: {
        id: "TASK-009",
        title: "Line 1\nLine 2",
        description: 'Need "quotes" and \t tabs',
      },
      workspace: {
        workspacePath: "/tmp/ws\nline",
        branchName: "branch\tname",
        baseCommit: "deadbeef",
        executionNumber: 7,
      },
    });

    const prompt = buildExecutorPrompt(input);

    expect(prompt).toContain(
      JSON.stringify(
        {
          project: { name: 'Alpha "Repo"' },
          task: {
            id: "TASK-009",
            title: "Line 1\nLine 2",
            description: 'Need "quotes" and \t tabs',
          },
          workspace: {
            workspacePath: "/tmp/ws\nline",
            branchName: "branch\tname",
            baseCommit: "deadbeef",
            executionNumber: 7,
          },
        },
        null,
        2,
      ),
    );
    expect(prompt).toContain("\\n");
    expect(prompt).toContain('\\"');
  });

  it("serializes the approved contract as JSON", () => {
    const input = createInput({
      contract: {
        objective: "Ship feature X",
        context: "Customer rollout",
        acceptanceCriteria: ["A", "B"],
        allowedPaths: ["src/a.ts", " src/b.ts "],
        forbiddenPaths: ["package-lock.json"],
        requiredCommands: ["npm test", " npm run build "],
        assumptions: ["Node 24"],
        risks: ["Low confidence"],
      },
    });

    const prompt = buildExecutorPrompt(input);

    expect(prompt).toContain(
      JSON.stringify(
        {
          objective: "Ship feature X",
          context: "Customer rollout",
          acceptanceCriteria: ["A", "B"],
          allowedPaths: ["src/a.ts", " src/b.ts "],
          forbiddenPaths: ["package-lock.json"],
          requiredCommands: ["npm test", " npm run build "],
          assumptions: ["Node 24"],
          risks: ["Low confidence"],
        },
        null,
        2,
      ),
    );
  });

  it("serializes empty arrays as []", () => {
    const prompt = buildExecutorPrompt(createInput());

    expect(prompt).toContain('"allowedPaths": []');
    expect(prompt).toContain('"forbiddenPaths": []');
    expect(prompt).toContain('"requiredCommands": []');
    expect(prompt).toContain('"assumptions": []');
    expect(prompt).toContain('"risks": []');
  });

  it("preserves array order and exact valid strings", () => {
    const prompt = buildExecutorPrompt(
      createInput({
        contract: {
          acceptanceCriteria: ["Criterion B", " Criterion A ", "Criterion C"],
          allowedPaths: ["src/b.ts", " src/a.ts ", "src/c.ts"],
          requiredCommands: ["npm run lint", " npm test ", "npm run build"],
        },
      }),
    );

    expect(prompt).toContain('"acceptanceCriteria": [\n    "Criterion B",\n    " Criterion A ",\n    "Criterion C"\n  ]');
    expect(prompt).toContain('"allowedPaths": [\n    "src/b.ts",\n    " src/a.ts ",\n    "src/c.ts"\n  ]');
    expect(prompt).toContain('"requiredCommands": [\n    "npm run lint",\n    " npm test ",\n    "npm run build"\n  ]');
  });

  it("includes the execution context fields", () => {
    const prompt = buildExecutorPrompt(createInput());

    expect(prompt).toContain('"name": "Alpha"');
    expect(prompt).toContain('"id": "TASK-001"');
    expect(prompt).toContain('"title": "Implement feature"');
    expect(prompt).toContain('"description": "Build the first slice"');
    expect(prompt).toContain('"workspacePath": "/tmp/devflow/worktree"');
    expect(prompt).toContain('"branchName": "devflow/proj/task/execution-1"');
    expect(prompt).toContain('"baseCommit": "abc123def456"');
    expect(prompt).toContain('"executionNumber": 1');
  });

  it("includes the approved contract fields", () => {
    const prompt = buildExecutorPrompt(createInput());

    expect(prompt).toContain('"objective": "Implement the approved feature."');
    expect(prompt).toContain('"context": "The release depends on this behavior."');
    expect(prompt).toContain('"acceptanceCriteria": [');
    expect(prompt).toContain('"allowedPaths": []');
    expect(prompt).toContain('"forbiddenPaths": []');
    expect(prompt).toContain('"requiredCommands": []');
    expect(prompt).toContain('"assumptions": []');
    expect(prompt).toContain('"risks": []');
  });

  it("excludes fields outside the approved prompt contract", () => {
    const prompt = buildExecutorPrompt(createInput());

    expect(prompt).not.toContain("repositoryPath");
    expect(prompt).not.toContain("projectId");
    expect(prompt).not.toContain("currentRevisionJson");
    expect(prompt).not.toContain("pendingHumanRequests");
    expect(prompt).not.toContain("openQuestions");
    expect(prompt).not.toContain('"attempt"');
    expect(prompt).not.toContain('"maxAttempts"');
    expect(prompt).not.toContain("undefined");
  });

  it("states the operational restrictions", () => {
    const prompt = buildExecutorPrompt(createInput());

    expect(prompt).toContain("trabajar exclusivamente dentro de /tmp/devflow/worktree");
    expect(prompt).toContain("no hacer commit");
    expect(prompt).toContain("no hacer push");
    expect(prompt).toContain("no cambiar de branch");
    expect(prompt).toContain("no crear worktrees");
    expect(prompt).toContain("no editar fuera del workspace");
    expect(prompt).toContain("no modificar el worktree principal");
    expect(prompt).toContain("respetar allowedPaths");
    expect(prompt).toContain("no modificar forbiddenPaths");
    expect(prompt).toContain("no agregar dependencias sin justificación");
    expect(prompt).toContain("no afirmar que un comando se ejecutó si no se ejecutó");
  });

  it("states the envelope contract and output policy", () => {
    const prompt = buildExecutorPrompt(createInput());

    expect(prompt).toContain('"protocolVersion": 1');
    expect(prompt).toContain('"role": "executor"');
    expect(prompt).toContain('"status": "COMPLETED | NEEDS_INPUT | BLOCKED | FAILED"');
    expect(prompt).toContain('"filesClaimed": ["string"]');
    expect(prompt).toContain('"commandsClaimed": ["string"]');
    expect(prompt).toContain("JSON puro.");
    expect(prompt).toContain("Sin markdown.");
    expect(prompt).toContain("Sin fences.");
    expect(prompt).toContain("Sin texto adicional.");
  });

  it("documents the four valid statuses", () => {
    const prompt = buildExecutorPrompt(createInput());

    expect(prompt).toContain("- COMPLETED: la ejecución solicitada terminó.");
    expect(prompt).toContain("- NEEDS_INPUT: necesitas información adicional.");
    expect(prompt).toContain("- BLOCKED: existe un bloqueo que impide continuar.");
    expect(prompt).toContain("- FAILED: la ejecución no pudo completarse.");
  });

  it("does not mutate the input object or arrays", () => {
    const input = createInput({
      contract: {
        acceptanceCriteria: ["A", " B "],
        allowedPaths: ["src/a.ts"],
        forbiddenPaths: ["dist"],
        requiredCommands: ["npm test"],
        assumptions: ["Node"],
        risks: ["Low confidence"],
      },
    });
    const snapshot = JSON.parse(JSON.stringify(input));

    buildExecutorPrompt(input);

    expect(input).toEqual(snapshot);
  });

  it("error copies the path defensively", () => {
    const path: (string | number)[] = ["contract", "objective"];
    const error = new ExecutorPromptBuildError("boom", {
      code: "INVALID_CONTRACT_OBJECTIVE",
      path,
    });

    path.push("mutated");

    expect(error.path).toEqual(["contract", "objective"]);
  });

  it("rejects empty project.name", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ project: { name: "   " } })),
      "INVALID_PROJECT_NAME",
      ["project", "name"],
    );
  });

  it("rejects empty task.id", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ task: { id: "" } })),
      "INVALID_TASK_ID",
      ["task", "id"],
    );
  });

  it("rejects empty task.title", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ task: { title: " " } })),
      "INVALID_TASK_TITLE",
      ["task", "title"],
    );
  });

  it("rejects empty task.description", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ task: { description: "\n\t" } })),
      "INVALID_TASK_DESCRIPTION",
      ["task", "description"],
    );
  });

  it("rejects empty contract.objective", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ contract: { objective: "  " } })),
      "INVALID_CONTRACT_OBJECTIVE",
      ["contract", "objective"],
    );
  });

  it("rejects empty contract.context", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ contract: { context: "  " } })),
      "INVALID_CONTRACT_CONTEXT",
      ["contract", "context"],
    );
  });

  it("rejects empty acceptanceCriteria", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ contract: { acceptanceCriteria: [] } })),
      "INVALID_ACCEPTANCE_CRITERIA",
      ["contract", "acceptanceCriteria"],
    );
  });

  it("rejects empty acceptanceCriteria item", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ contract: { acceptanceCriteria: ["ok", "   "] } })),
      "INVALID_ACCEPTANCE_CRITERIA",
      ["contract", "acceptanceCriteria", 1],
    );
  });

  it("rejects empty allowedPaths item", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ contract: { allowedPaths: ["src", " "] } })),
      "INVALID_ALLOWED_PATHS",
      ["contract", "allowedPaths", 1],
    );
  });

  it("rejects empty forbiddenPaths item", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ contract: { forbiddenPaths: ["dist", ""] } })),
      "INVALID_FORBIDDEN_PATHS",
      ["contract", "forbiddenPaths", 1],
    );
  });

  it("rejects empty requiredCommands item", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ contract: { requiredCommands: ["npm test", "\t"] } })),
      "INVALID_REQUIRED_COMMANDS",
      ["contract", "requiredCommands", 1],
    );
  });

  it("rejects empty assumptions item", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ contract: { assumptions: ["Node", " "] } })),
      "INVALID_ASSUMPTIONS",
      ["contract", "assumptions", 1],
    );
  });

  it("rejects empty risks item", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ contract: { risks: ["Low", "  "] } })),
      "INVALID_RISKS",
      ["contract", "risks", 1],
    );
  });

  it("rejects empty workspacePath", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ workspace: { workspacePath: "  " } })),
      "INVALID_WORKSPACE_PATH",
      ["workspace", "workspacePath"],
    );
  });

  it("rejects empty branchName", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ workspace: { branchName: "  " } })),
      "INVALID_BRANCH_NAME",
      ["workspace", "branchName"],
    );
  });

  it("rejects empty baseCommit", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ workspace: { baseCommit: "  " } })),
      "INVALID_BASE_COMMIT",
      ["workspace", "baseCommit"],
    );
  });

  it("rejects executionNumber zero", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ workspace: { executionNumber: 0 } })),
      "INVALID_EXECUTION_NUMBER",
      ["workspace", "executionNumber"],
    );
  });

  it("rejects executionNumber negative", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ workspace: { executionNumber: -1 } })),
      "INVALID_EXECUTION_NUMBER",
      ["workspace", "executionNumber"],
    );
  });

  it("rejects executionNumber decimal", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ workspace: { executionNumber: 1.5 } })),
      "INVALID_EXECUTION_NUMBER",
      ["workspace", "executionNumber"],
    );
  });

  it("rejects executionNumber NaN", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ workspace: { executionNumber: Number.NaN } })),
      "INVALID_EXECUTION_NUMBER",
      ["workspace", "executionNumber"],
    );
  });

  it("rejects executionNumber Infinity", () => {
    expectBuildError(
      () => buildExecutorPrompt(createInput({ workspace: { executionNumber: Number.POSITIVE_INFINITY } })),
      "INVALID_EXECUTION_NUMBER",
      ["workspace", "executionNumber"],
    );
  });
});
