import { assertEquals, assertThrows } from "@std/assert";
import { RequestError } from "../_shared/errors.ts";
import { validateInput } from "./contract.ts";
import { fixtureBinding, fixtureInput } from "./test-support.ts";

function purchase() {
  const input = fixtureInput();
  return {
    ...input,
    // Before identity verification, this is a stable purchase-scoped identifier.
    learner_id: input.order_id,
    context: {
      purchase_id: input.order_id!,
      intake_id: "ac570000-0000-4000-8000-000000000060",
      terms_hash: input.reservation_id!,
    },
  };
}

Deno.test("intake purchase needs no registration, assessment or cohort identity", () => {
  const input = purchase();
  assertEquals(validateInput(input, fixtureBinding), input);
  assertEquals(validateInput(fixtureInput(), fixtureBinding).action, "create");
});

Deno.test("intake purchase context cannot mix placement fields or escape its immutable order and terms", () => {
  const input = purchase();
  for (
    const context of [
      { ...input.context, purchase_id: crypto.randomUUID() },
      { ...input.context, intake_id: "not-an-intake" },
      { ...input.context, terms_hash: "b".repeat(64) },
      { ...input.context, terms_hash: "A".repeat(64) },
      { ...input.context, registration_id: crypto.randomUUID() },
      { ...input.context, cohort_id: crypto.randomUUID() },
      { ...input.context, calendar_hash: "a".repeat(64) },
      {
        purchase_id: input.context.purchase_id,
        terms_hash: input.context.terms_hash,
      },
      {
        intake_id: input.context.intake_id,
        terms_hash: input.context.terms_hash,
      },
      {
        purchase_id: input.context.purchase_id,
        intake_id: input.context.intake_id,
      },
      {},
    ]
  ) {
    assertThrows(
      () => validateInput({ ...input, context }, fixtureBinding),
      RequestError,
    );
  }
});
