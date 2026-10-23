/** Production OTP transport against disposable local Auth; never hosted services. */
import { sendInvitationOtp } from "../supabase/functions/merchant-connect/invitation-otp.ts";

const origin = Deno.env.get("MERCHANT_OTP_AUTH_URL") ?? "";
const email = Deno.env.get("MERCHANT_OTP_AUTH_EMAIL") ?? "";
const key = Deno.env.get("MERCHANT_OTP_AUTH_KEY") ?? "";
if (
  new URL(origin).hostname !== "127.0.0.1" ||
  !email.endsWith(".example.invalid") || !key
) {
  throw Error("Disposable loopback Auth fixture required.");
}
const result = await sendInvitationOtp(email, origin, (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url,
  );
  if (url.origin !== origin) throw Error("External requests are forbidden.");
  return fetch(input, init);
}, (name) => {
  if (name === "SUPABASE_URL") return origin;
  if (name === "SUPABASE_ANON_KEY") return key;
  throw Error("Unexpected configuration request.");
});
console.log(JSON.stringify(result));
