import { afterEach, describe, expect, it, vi } from "vitest";
import { browserStorage, getSaveStatus, memoryStorage, subscribeSaveStatus } from "@/stores/game/persist";

afterEach(() => vi.unstubAllGlobals());

describe("доступность сохранения", () => {
  it("сообщает о недоступном хранилище и продолжает работу в памяти", () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("blocked"); } });
    const storage = browserStorage();
    expect(getSaveStatus()).toBe("volatile");
    storage.setItem("save", "progress");
    expect(storage.getItem("save")).toBe("progress");
  });

  it("переходит в память, если квота закончилась после успешного запуска", () => {
    const disk = memoryStorage();
    const original = disk.setItem;
    let blocked = false;
    disk.setItem = (key, value) => {
      if (blocked) throw new Error("quota");
      original(key, value);
    };
    vi.stubGlobal("window", { localStorage: disk });
    const storage = browserStorage();
    expect(getSaveStatus()).toBe("persistent");
    const listener = vi.fn();
    const unsubscribe = subscribeSaveStatus(listener);
    blocked = true;
    expect(() => storage.setItem("save", "new progress")).not.toThrow();
    expect(getSaveStatus()).toBe("volatile");
    expect(listener).toHaveBeenCalledOnce();
    expect(storage.getItem("save")).toBe("new progress");
    unsubscribe();
  });
});
