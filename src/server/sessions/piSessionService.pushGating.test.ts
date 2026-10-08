import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AskUserQuestion } from "../../shared/apiTypes.js";
import { PiSessionService } from "./piSessionService.js";
import {
  CapturingSessionEventHub,
  emptyArchiveStore,
  fakeRuntime,
  runtimeCreator,
  sessionGateway,
  sessionRecord,
  sessionRef,
  testModelRuntime,
} from "./piSessionService.testSupport.js";
import { SessionUnreadStore } from "./sessionUnreadStore.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const WORKSPACE_CWD = resolve("/workspace");

async function serviceFor(): Promise<{ service: PiSessionService; session: ReturnType<typeof fakeRuntime>["session"] }> {
  const fake = fakeRuntime("session-1");
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord("session-1")]),
    archiveStore: emptyArchiveStore(),
    heartbeatIntervalMs: 60_000,
    unreadStore: new SessionUnreadStore(),
    onUnreadChanged: vi.fn(),
  });
  await service.status(sessionRef("session-1"));
  return { service, session: fake.session };
}

describe("PiSessionService.mayNotifyCompletion", () => {
  it("notifies for a finished session and for one that already exited", async () => {
    const { service } = await serviceFor();
    try {
      expect(service.mayNotifyCompletion("session-1", WORKSPACE_CWD)).toBe(true);
      expect(service.mayNotifyCompletion("exited-session", WORKSPACE_CWD)).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  it("suppresses while work is still active or the cwd no longer matches", async () => {
    const { service, session } = await serviceFor();
    try {
      // Simulated in-flight work: the native completion is not trustworthy yet.
      session.isStreaming = true;
      expect(service.mayNotifyCompletion("session-1", WORKSPACE_CWD)).toBe(false);
      session.isStreaming = false;
      expect(service.mayNotifyCompletion("session-1", WORKSPACE_CWD)).toBe(true);
      expect(service.mayNotifyCompletion("session-1", "/elsewhere")).toBe(false);
    } finally {
      await service.dispose();
    }
  });

  it("suppresses while an ask_user question is pending, through the public ask API", async () => {
    const { service } = await serviceFor();
    try {
      const questions: AskUserQuestion[] = [{ id: "q1", question: "Continue?", options: [] }];
      const opened = await service.openAsk({ sessionId: "session-1", questions });
      expect(service.mayNotifyCompletion("session-1", WORKSPACE_CWD)).toBe(false);
      await service.cancelAsk(sessionRef("session-1"), opened.ask.askId);
      expect(service.mayNotifyCompletion("session-1", WORKSPACE_CWD)).toBe(true);
    } finally {
      await service.dispose();
    }
  });
});
