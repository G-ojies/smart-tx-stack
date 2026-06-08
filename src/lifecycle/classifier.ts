import { FailureClass } from "../types";
import type { BundleResult } from "jito-ts/dist/gen/block-engine/bundle";

/**
 * Classify a failure from either an RPC/transaction error or a Jito
 * BundleResult. Returns one of the four required classes (or unknown).
 */
export function classifyError(errLike: unknown): FailureClass {
  const s = stringify(errLike).toLowerCase();
  if (!s) return "none";

  if (s.includes("blockhash") && (s.includes("expired") || s.includes("not found") || s.includes("invalid")))
    return "expired_blockhash";
  if (s.includes("block height exceeded") || s.includes("blockhashnotfound"))
    return "expired_blockhash";

  if (s.includes("insufficient") && s.includes("fee")) return "fee_too_low";
  if (s.includes("fee too low") || s.includes("priority fee")) return "fee_too_low";

  if (s.includes("computational budget") || s.includes("compute") && s.includes("exceeded"))
    return "compute_exceeded";
  if (s.includes("exceeded cus") || s.includes("computeunitlimit")) return "compute_exceeded";

  if (s.includes("bundle")) return "bundle_failure";

  return "unknown";
}

/**
 * Interpret a Jito BundleResult into a failure class (or "none" if it landed).
 * BundleResult is a oneof: accepted | rejected | dropped | finalized | processed.
 */
export function classifyBundleResult(res: BundleResult): FailureClass {
  const r: any = res;
  if (r.accepted || r.finalized || r.processed) return "none";
  if (r.dropped) return "bundle_failure";
  if (r.rejected) {
    // rejected has nested reasons (e.g. simulation failure, state auction loss)
    return classifyError(JSON.stringify(r.rejected));
  }
  return "unknown";
}

function stringify(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return `${e.message} ${(e as any).stack ?? ""}`;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
