import { afterEach, expect, it, vi } from "vitest";
import { createEngineClient } from "@/engine";
import { FakeWorker, RUNTIME_CASE } from "./fixture";

afterEach(() => vi.unstubAllGlobals());

it("использует прерываемый worker без IndexedDB и восстанавливается после таймаута", async () => {
  vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("Worker", FakeWorker);
  const client = createEngineClient({ timeoutMs: 50 });
  try {
    expect(client.mode).toBe("worker");
    await client.init();
    await client.openCase(RUNTIME_CASE);
    const result = await client.run("SELECT 1 /* HANG */");
    expect(result.result.errorKind).toBe("timeout");
    expect((await client.run("SELECT 1")).result.rows).toEqual([[1]]);
  } finally {
    client.dispose();
  }
}, 30_000);
