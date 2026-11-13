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

// Programs that pay for events, captured from supabase/tests/database/84_program_reward_terms.sql:
// marketplace_programs.mixed, and the program of partner_program_detail.events and .both, which
// is kma_internal.program_detail, the same function marketplace_program answers with. The two
// entries above are captured from before programs could pay for events and are read exactly as
// they were.

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
    ["rival-reader", "both"],
    ["fluent", "events"],
    ["quiet-club", "sales"],
  ]);
  const [both, events, sales] = programs;
  assertEquals(events.commission_type, null);
  assertEquals(events.commission_duration, null);
  assertEquals(events.rewards, [
    { key: "account_created", label: "Account created", amount_minor: 300 },
    { key: "trial_started", label: "Trial started", amount_minor: 500 },
    { key: "lesson_finished", label: "First lesson", amount_minor: 100 },
  ]);
  assertEquals(both.commission_type, "percent");
  assertEquals(both.rewards, [
    { key: "chapter_read", label: "First chapter read", amount_minor: 150 },
  ]);
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
  assertEquals(
    programDetail(backend.marketplace_program_events.program)?.earn_from,
    "events",
  );
  assertEquals(
    programDetail(backend.marketplace_program_both.program)?.earn_from,
    "both",
  );
});
