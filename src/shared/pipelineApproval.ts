export interface PipelineApprovalBinding {
  rootExecutionId: string;
  targetExecutionId: string;
  stage: "sketches" | "modules";
  questionId: string;
  revision: number;
  artifactSha256: string;
}

export function isPipelineExecutionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

export function readPipelineApproval(value: unknown): PipelineApprovalBinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("rootExecutionId" in value) || !isPipelineExecutionId(value.rootExecutionId) ||
      !("targetExecutionId" in value) || !isPipelineExecutionId(value.targetExecutionId) ||
      !("stage" in value) || (value.stage !== "sketches" && value.stage !== "modules") ||
      !("questionId" in value) || typeof value.questionId !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value.questionId) ||
      !("revision" in value) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !("artifactSha256" in value) || typeof value.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifactSha256)) return undefined;
  return { rootExecutionId: value.rootExecutionId, targetExecutionId: value.targetExecutionId, stage: value.stage,
    questionId: value.questionId, revision: value.revision, artifactSha256: value.artifactSha256 };
}
