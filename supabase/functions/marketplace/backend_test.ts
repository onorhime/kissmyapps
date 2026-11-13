import { assert, assertEquals } from "@std/assert";
import backend from "./backend.fixture.json" with { type: "json" };
import { programDetail, programList } from "./programs.ts";

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
