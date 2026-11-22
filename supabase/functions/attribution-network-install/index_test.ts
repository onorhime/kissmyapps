import { networkReport } from "./index.ts";
Deno.test("a reported install requires consent, explicit network and both first-launch identifiers", () => {
  const r = {
    network: "tiktok",
    platform: "android",
    report_id: "report-1",
    session_id: "ses-1",
    anonymous_id: "anon-1",
    campaign: " spring ",
    attribution_consent: true,
  };
  if (networkReport(r)?.campaign !== "spring") {
    throw Error("valid report rejected");
  }
  for (
    const bad of [
      { attribution_consent: false },
      { network: "unknown" },
      { session_id: "" },
      { anonymous_id: "" },
      { report_id: "x".repeat(101) },
    ]
  ) {
    if (networkReport({ ...r, ...bad })) throw Error("invalid report accepted");
  }
});
