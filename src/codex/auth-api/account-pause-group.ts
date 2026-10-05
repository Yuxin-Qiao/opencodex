import type { OcxConfig } from "../../types";
import { inspectChatGptDomainClaim, extractEmail } from "../../oauth/chatgpt";
import { MAIN_CODEX_ACCOUNT_ID, isSelectableCodexPoolAccount } from "../account-id";
import { readCodexTokensResult } from "../auth-collision";
import { getCodexAccountCredential } from "../account-store";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { isNativeMainClaimUnavailable, nativeMainProfileBusyResponse, withNativeMainCredentialClaim } from "./http";

type AccountIdentity = { accountId: string; email: string };

function identity(accountId: unknown, email: unknown): AccountIdentity | undefined {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : undefined;
  return typeof accountId === "string" && accountId.trim() && normalizedEmail
    ? { accountId: accountId.trim(), email: normalizedEmail }
    : undefined;
}

/** Resolve only existing entries, under native-main ownership, never on the request path. */
function linkedAccountIds(config: OcxConfig, selectedId: string): string[] | undefined {
  const main = readCodexTokensResult();
  // Unknown main identity must not produce a successful but incomplete pause.
  if (main.status === "unreadable" || main.status === "invalid") return undefined;
  const identities = new Map<string, AccountIdentity | undefined>();
  if (main.status === "ok") {
    const tokens = main.tokens;
    if (typeof tokens.access_token !== "string" || typeof tokens.account_id !== "string"
      || (tokens.id_token !== undefined && typeof tokens.id_token !== "string")) return undefined;
    const claims = [tokens.id_token, tokens.access_token]
      .filter((token): token is string => typeof token === "string")
      .map(inspectChatGptDomainClaim);
    if (claims.some(claim => claim.kind === "invalid")) return undefined;
    const claimIds = claims.flatMap(claim => claim.kind === "valid" ? [claim.accountId] : []);
    // organizations[] describes memberships, not the selected workspace. Never use its first row.
    const accountId = tokens.account_id.trim() || claimIds[0];
    if (claimIds.some(claim => claim !== accountId)) return undefined;
    identities.set(MAIN_CODEX_ACCOUNT_ID, identity(accountId, extractEmail(tokens.id_token, tokens.access_token)));
  }
  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account)) continue;
    const credential = getCodexAccountCredential(account.id);
    identities.set(account.id, identity(credential?.chatgptAccountId, account.email));
  }
  const selected = identities.get(selectedId);
  // Missing identity evidence never links unrelated logins, including members of one workspace.
  if (!selected) return [selectedId];
  return [selectedId, ...[...identities].flatMap(([id, candidate]) => (
    id !== selectedId && candidate?.accountId === selected.accountId && candidate.email === selected.email
      ? [id] : []
  ))];
}

/** Keep discovery, publication and persistence inside the same physical-main claim. */
export async function withCodexAccountPauseGroup(
  config: OcxConfig,
  selectedId: string,
  publish: (accountIds: string[]) => Response,
): Promise<Response> {
  const lease = tryAcquireNativeMainProfileClaim();
  if (!lease) return nativeMainProfileBusyResponse();
  try {
    return await withNativeMainCredentialClaim(async () => {
      const ids = linkedAccountIds(config, selectedId);
      return ids ? publish(ids) : nativeMainProfileBusyResponse();
    });
  } catch (error) {
    if (isNativeMainClaimUnavailable(error)) return nativeMainProfileBusyResponse();
    throw error;
  } finally {
    lease.release();
  }
}
