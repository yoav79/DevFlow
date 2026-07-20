import { describe, expect, it } from "vitest";

import {
  buildSupervisorPrompt,
  SupervisorPromptBuildError,
  type SupervisorPromptInput,
} from "../../src/services/supervisor-prompt-builder.js";

type TestInputOverrides = {
  project?: Partial<SupervisorPromptInput["project"]>;
  task?: Partial<SupervisorPromptInput["task"]>;
  pendingHumanRequests?: SupervisorPromptInput["pendingHumanRequests"];
};

function createInput(overrides: TestInputOverrides = {}): SupervisorPromptInput {
  return {
    project: {
      name: "Alpha",
      repositoryPath: "/repo/main",
      ...(overrides.project ?? {}),
    },
    task: {
      id: "TASK-001",
      title: "Implement feature",
      description: "Build the first slice",
      state: "CREATED",
      attempt: 0,
      maxAttempts: 2,
      contractJson: null,
      currentRevisionJson: null,
      ...(overrides.task ?? {}),
    },
    pendingHumanRequests: overrides.pendingHumanRequests ?? [],
  };
}

function expectBuildError(
  fn: () => string,
  code: SupervisorPromptBuildError["code"],
  path: readonly (string | number)[],
): SupervisorPromptBuildError {
  try {
    fn();
    expect.fail("Should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(SupervisorPromptBuildError);
    const typed = error as SupervisorPromptBuildError;
    expect(typed.code).toBe(code);
    expect(typed.path).toEqual(path);
    expect(typed.name).toBe("SupervisorPromptBuildError");
    return typed;
  }
}

describe("buildSupervisorPrompt", () => {
  it("is deterministic for the same input", () => {
    const input = createInput();

    const first = buildSupervisorPrompt(input);
    const second = buildSupervisorPrompt(input);

    expect(first).toBe(second);
  });

  it("keeps the fixed section order", () => {
    const prompt = buildSupervisorPrompt(createInput());

    const sections = [
      "IDENTIDAD",
      "MISIÓN",
      "RESTRICCIONES DURAS",
      "CONTEXTO JSON",
      "CONTRATO DEL ENVELOPE",
      "PAYLOAD EXECUTABLE_TASK",
      "PAYLOAD NEEDS_DECOMPOSITION",
      "PAYLOAD NEEDS_DISCOVERY",
      "REGLAS DE CLASIFICACIÓN",
      "REGLA FINAL DE RESPUESTA",
    ];

    let lastIndex = -1;
    for (const section of sections) {
      const index = prompt.indexOf(section);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("serializes the real context as JSON", () => {
    const input = createInput({
      project: {
        name: "Alpha \"Repo\"",
        repositoryPath: "/repo/main",
      },
      task: {
        id: "TASK-001",
        title: "Line 1\nLine 2",
        description: "Need \"quotes\" and \t tabs",
        state: "CREATED",
        attempt: 1,
        maxAttempts: 2,
        contractJson: null,
        currentRevisionJson: null,
      },
      pendingHumanRequests: [],
    });

    const prompt = buildSupervisorPrompt(input);

    expect(prompt).toContain(
      JSON.stringify(
        {
          project: {
            name: 'Alpha "Repo"',
            repositoryPath: "/repo/main",
          },
          task: {
            id: "TASK-001",
            title: "Line 1\nLine 2",
            description: 'Need "quotes" and \t tabs',
            state: "CREATED",
            attempt: 1,
            maxAttempts: 2,
            contractJson: null,
            currentRevisionJson: null,
          },
          pendingHumanRequests: [],
        },
        null,
        2,
      ),
    );
    expect(prompt).toContain("\\n");
    expect(prompt).toContain('\\"');
  });

  it("keeps empty pending human requests as []", () => {
    const prompt = buildSupervisorPrompt(createInput());

    expect(prompt).toContain('"pendingHumanRequests": []');
  });

  it("preserves null contract and revision fields", () => {
    const prompt = buildSupervisorPrompt(createInput());

    expect(prompt).toContain('"contractJson": null');
    expect(prompt).toContain('"currentRevisionJson": null');
  });

  it("does not include undefined", () => {
    const prompt = buildSupervisorPrompt(createInput());

    expect(prompt).not.toContain("undefined");
  });

  it("states the envelope contract exactly", () => {
    const prompt = buildSupervisorPrompt(createInput());

    expect(prompt).toContain('protocolVersion: 1');
    expect(prompt).toContain('role: "supervisor"');
    expect(prompt).toContain('status: "COMPLETED"');
    expect(prompt).toContain('summary: string no vacío');
    expect(prompt).toContain('questions: string[]');
    expect(prompt).toContain('risks: string[]');
    expect(prompt).toContain('payload: uno de los tres payloads válidos');
  });

  it("describes the EXECUTABLE_TASK payload", () => {
    const prompt = buildSupervisorPrompt(createInput());

    expect(prompt).toContain('classification: "EXECUTABLE_TASK"');
    expect(prompt).toContain('acceptanceCriteria debe tener al menos un elemento');
    expect(prompt).toContain('openQuestions: []');
  });

  it("describes the NEEDS_DECOMPOSITION payload", () => {
    const prompt = buildSupervisorPrompt(createInput());

    expect(prompt).toContain('classification: "NEEDS_DECOMPOSITION"');
    expect(prompt).toContain('debe proponer al menos dos tareas');
  });

  it("describes the NEEDS_DISCOVERY payload", () => {
    const prompt = buildSupervisorPrompt(createInput());

    expect(prompt).toContain('classification: "NEEDS_DISCOVERY"');
    expect(prompt).toContain('missingInformation y recommendedDiscoveryActions deben tener al menos un elemento');
  });

  it("forbids file modification and extra output", () => {
    const prompt = buildSupervisorPrompt(createInput());

    expect(prompt).toContain('no modificar archivos');
    expect(prompt).toContain('no crear archivos');
    expect(prompt).toContain('no eliminar archivos');
    expect(prompt).toContain('no escribir en disco');
    expect(prompt).toContain('no ejecutar cambios en el proyecto');
    expect(prompt).toContain('no responder con texto antes o después del JSON');
  });

  it("does not mutate input", () => {
    const input = createInput({
      pendingHumanRequests: [
        {
          id: "req-1",
          type: "FUNCTIONAL_DECISION",
          question: "Need input",
          optionsJson: JSON.stringify(["A", "B"]),
        },
      ],
    });
    const snapshot = JSON.parse(JSON.stringify(input));

    buildSupervisorPrompt(input);

    expect(input).toEqual(snapshot);
  });

  it("rejects an empty project name", () => {
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ project: { name: "   " } })),
      "INVALID_PROJECT_NAME",
      ["project", "name"],
    );
  });

  it("rejects an empty repository path", () => {
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ project: { repositoryPath: "  " } })),
      "INVALID_REPOSITORY_PATH",
      ["project", "repositoryPath"],
    );
  });

  it("rejects an empty task title", () => {
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ task: { title: "" } })),
      "INVALID_TASK_TITLE",
      ["task", "title"],
    );
  });

  it("rejects an empty task id", () => {
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ task: { id: "   " } })),
      "INVALID_TASK_ID",
      ["task", "id"],
    );
  });

  it("rejects an empty task description", () => {
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ task: { description: "   " } })),
      "INVALID_TASK_DESCRIPTION",
      ["task", "description"],
    );
  });

  it("rejects invalid attempt values", () => {
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ task: { attempt: -1 } })),
      "INVALID_ATTEMPT_RANGE",
      ["task", "attempt"],
    );
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ task: { attempt: 1.5 } })),
      "INVALID_ATTEMPT_RANGE",
      ["task", "attempt"],
    );
  });

  it("rejects invalid maxAttempts values", () => {
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ task: { maxAttempts: 0 } })),
      "INVALID_ATTEMPT_RANGE",
      ["task", "maxAttempts"],
    );
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ task: { maxAttempts: 1.2 } })),
      "INVALID_ATTEMPT_RANGE",
      ["task", "maxAttempts"],
    );
  });

  it("rejects attempt greater than maxAttempts", () => {
    expectBuildError(
      () => buildSupervisorPrompt(createInput({ task: { attempt: 3, maxAttempts: 2 } })),
      "INVALID_ATTEMPT_RANGE",
      ["task", "attempt"],
    );
  });

  it("rejects invalid human requests", () => {
    expectBuildError(
      () =>
        buildSupervisorPrompt(
          createInput({
            pendingHumanRequests: [
              {
                id: " ",
                type: "FUNCTIONAL_DECISION",
                question: "Need input",
                optionsJson: JSON.stringify(["A"]),
              },
            ],
          }),
        ),
      "INVALID_HUMAN_REQUEST",
      ["pendingHumanRequests", 0, "id"],
    );
  });

  it("rejects empty human request type", () => {
    expectBuildError(
      () =>
        buildSupervisorPrompt(
          createInput({
            pendingHumanRequests: [
              {
                id: "req-1",
                type: "   ",
                question: "Need input",
                optionsJson: JSON.stringify(["A"]),
              },
            ],
          }),
        ),
      "INVALID_HUMAN_REQUEST",
      ["pendingHumanRequests", 0, "type"],
    );
  });

  it("rejects empty human request question", () => {
    expectBuildError(
      () =>
        buildSupervisorPrompt(
          createInput({
            pendingHumanRequests: [
              {
                id: "req-1",
                type: "FUNCTIONAL_DECISION",
                question: "   ",
                optionsJson: JSON.stringify(["A"]),
              },
            ],
          }),
        ),
      "INVALID_HUMAN_REQUEST",
      ["pendingHumanRequests", 0, "question"],
    );
  });

  it("rejects empty human request optionsJson", () => {
    expectBuildError(
      () =>
        buildSupervisorPrompt(
          createInput({
            pendingHumanRequests: [
              {
                id: "req-1",
                type: "FUNCTIONAL_DECISION",
                question: "Need input",
                optionsJson: "   ",
              },
            ],
          }),
        ),
      "INVALID_HUMAN_REQUEST",
      ["pendingHumanRequests", 0, "optionsJson"],
    );
  });
});
