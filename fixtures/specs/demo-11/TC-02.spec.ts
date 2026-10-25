import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-02";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.as("user:standard");
    await ui.goto("/app/notes");
    await ui.setOffline(true);
    await ui.fill("testid:note-text", "Buy stamps");
    await ui.click("testid:add-note");
    verify(
      "S1",
      "elements.testid:connection.text",
      undefined,
      plan.expect("TC-02.S1.elements.testid:connection.text"),
    );
    verify(
      "S1",
      "elements.testid:queued-count.text",
      undefined,
      plan.expect("TC-02.S1.elements.testid:queued-count.text"),
    );
    verify(
      "S1",
      "elements.testid:saved-count.text",
      undefined,
      plan.expect("TC-02.S1.elements.testid:saved-count.text"),
    );
  });
  await step("S2", async () => {
    await ui.setOffline(false);
    // The queue empties once the sync is over, whether it saved the notes or not.
    await ui.waitFor("testid:queued-count >> has-text:0");
    verify(
      "S2",
      "elements.testid:connection.text",
      undefined,
      plan.expect("TC-02.S2.elements.testid:connection.text"),
    );
    verify(
      "S2",
      "elements.testid:queued-count.text",
      undefined,
      plan.expect("TC-02.S2.elements.testid:queued-count.text"),
    );
    verify(
      "S2",
      "elements.testid:saved-count.text",
      undefined,
      plan.expect("TC-02.S2.elements.testid:saved-count.text"),
    );
  });
}
