import { test, expect, setDefaultTimeout } from "bun:test";

setDefaultTimeout(60_000); // see test/setup.ts

test("isTrackingIssue: task list of only issue references", async () => {
  const { isTrackingIssue } = await import("../src/github/issues.ts");
  expect(isTrackingIssue("- [ ] #80\n- [x] #81")).toBe(true);
  expect(isTrackingIssue("Epic\n\n* [ ] #80\n- [ ] owner/repo#5")).toBe(true);
  expect(isTrackingIssue("- [ ] #80\n- [ ] do a thing")).toBe(false);
  expect(isTrackingIssue("no list, see #80")).toBe(false);
  expect(isTrackingIssue(null)).toBe(false);
});
