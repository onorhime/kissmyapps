import { createAgreementNotifyHandler } from "../_shared/agreement-email-worker.ts";
export { createAgreementNotifyHandler };
export const handleAgreementNotify = createAgreementNotifyHandler();
if (import.meta.main) Deno.serve(handleAgreementNotify);
