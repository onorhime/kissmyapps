import { assert, assertEquals } from "@std/assert";
import backend from "./backend.fixture.json" with { type: "json" };
import { programAnswer, programDetail, programList } from "./programs.ts";

// What public.marketplace_programs() and public.marketplace_program() really return,
// captured from supabase/tests/database/76_program_join.sql (its "capture" lines). The
// function refuses any answer that is not the agreed shape, so this proves the two fit.

Deno.test("the real list answer passes the shape check", () => {
  const programs = programList(backend.marketplace_programs);
  assert(programs !== null);
  assertEquals(programs.length, backend.marketplace_programs.programs.length);
  assertEquals(programs[0].slug, backend.marketplace_programs.programs[0].slug);
});

Deno.test("the real program answer passes the shape check and loses only its id", () => {
  const real = backend.marketplace_program.program;
  const program = programDetail(real);
  assert(program !== null);
  assertEquals(program.slug, real.slug);
  assertEquals(program.agreement_sha256, real.agreement_sha256);
  assertEquals(program.agreement.title, real.agreement.title);
  assertEquals(
    Object.keys(real).filter((key) => !(key in program)),
    ["id"],
  );
});

// Programs that pay for events. These three entries are written by hand to the Phase 6
// contract's card (earn_from, rewards); the two entries above are captured output from
// before it and are read exactly as they were.

Deno.test("an answer from before programs paid for events is passed on unchanged", () => {
  const programs = programList(backend.marketplace_programs);
  assert(programs !== null);
  assertEquals<unknown>(programs, backend.marketplace_programs.programs);
  for (const card of programs) {
    assertEquals("earn_from" in card, false);
    assertEquals("rewards" in card, false);
  }
  const { id: _id, ...real } = backend.marketplace_program.program;
  assertEquals<unknown>(
    programDetail(backend.marketplace_program.program),
    real,
  );
});

Deno.test("a list with sales, events and both programs passes the shape check", () => {
  const real = backend.marketplace_programs_mixed.programs;
  const programs = programList(backend.marketplace_programs_mixed);
  assert(programs !== null);
  assertEquals<unknown>(programs, real);
  assertEquals(programs.map((card) => [card.slug, card.earn_from]), [
    ["pocket-chef", "both"],
    ["fluent", "events"],
    ["speaksix", "sales"],
  ]);
  const [both, events, sales] = programs;
  assertEquals(events.commission_type, null);
  assertEquals(events.commission_duration, null);
  assertEquals(events.rewards, [
    { key: "signup_completed", label: "Account created", amount_minor: 200 },
    { key: "trial_started", label: "Trial started", amount_minor: 500 },
  ]);
  assertEquals(both.commission_type, "percent");
  assertEquals(both.rewards?.length, 1);
  assertEquals(sales.rewards, []);
});

Deno.test("an events program and a both program pass the shape check and lose only their id", () => {
  for (
    const answer of [
      backend.marketplace_program_events,
      backend.marketplace_program_both,
    ]
  ) {
    const { id: _id, ...real } = answer.program;
    assertEquals<unknown>(programDetail(answer.program), real);
    assertEquals<unknown>(programAnswer(answer), real);
  }
});
