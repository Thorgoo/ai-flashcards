import { describe, expect, it } from "vitest";
import { answered, createQueue, current, drop, isDone } from "./study-queue";

describe("study queue", () => {
  it("shows the cards in the given order and ends after correct answers", () => {
    let queue = createQueue(["a", "b", "c"]);
    expect(current(queue)).toBe("a");
    queue = answered(queue, true);
    expect(current(queue)).toBe("b");
    queue = answered(answered(queue, true), true);
    expect(isDone(queue)).toBe(true);
    expect(current(queue)).toBeNull();
  });

  it("sends a wrong card to the end", () => {
    const queue = answered(createQueue(["a", "b", "c"]), false);
    expect(queue).toEqual(["b", "c", "a"]);
  });

  it("brings a wrong last card back at once", () => {
    let queue = answered(answered(createQueue(["a", "b"]), true), false);
    expect(current(queue)).toBe("b");
    expect(isDone(queue)).toBe(false);
    queue = answered(queue, true);
    expect(isDone(queue)).toBe(true);
  });

  it("ends after a wrong and then a correct answer to the only card", () => {
    let queue = answered(createQueue(["a"]), false);
    expect(current(queue)).toBe("a");
    queue = answered(queue, true);
    expect(isDone(queue)).toBe(true);
  });

  it("drops a deleted card wherever it is", () => {
    const queue = createQueue(["a", "b", "c"]);
    expect(drop(queue, "a")).toEqual(["b", "c"]);
    expect(drop(queue, "b")).toEqual(["a", "c"]);
    expect(drop(queue, "x")).toEqual(["a", "b", "c"]);
    expect(isDone(drop(createQueue(["a"]), "a"))).toBe(true);
  });

  it("does not change the queue it was given", () => {
    const ids = ["a", "b"];
    const queue = createQueue(ids);
    answered(queue, false);
    drop(queue, "a");
    expect(queue).toEqual(["a", "b"]);
    expect(ids).toEqual(["a", "b"]);
  });

  it("leaves an empty queue as it is", () => {
    expect(answered(createQueue([]), false)).toEqual([]);
  });
});
