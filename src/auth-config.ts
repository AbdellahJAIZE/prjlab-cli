import { createHash } from "node:crypto";
export class LoginError extends Error {}
export interface LoginConfig {
  origin: string;
  authority: string;
  tenantId: string;
  clientId: string;
  scope: string;
  allowLoopbackHttp: boolean;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Public identifiers of the hosted PrjLab service; none of them is a secret.
// Environment variables override them for self-hosted or development servers.
export const HOSTED_SERVICE = Object.freeze({
  PRJ_SERVER: "https://prjlab.com",
  PRJ_AUTHORITY:
    "https://b7c0ef89-ea39-404f-ac7c-3737960bcb9e.ciamlogin.com/b7c0ef89-ea39-404f-ac7c-3737960bcb9e",
  PRJ_CLIENT_ID: "5e51d5dc-695d-4ca1-a93a-044daf8a39d9",
  PRJ_API_SCOPE: "api://56ec374f-1c3c-4e3e-a4c7-e5e7fae75c9d/access_as_user",
});
export function readLoginConfig(
  env: NodeJS.ProcessEnv = process.env,
): LoginConfig {
  try {
    const setting = (name: keyof typeof HOSTED_SERVICE) =>
      env[name] === undefined || env[name] === ""
        ? HOSTED_SERVICE[name]
        : env[name];
    const server = setting("PRJ_SERVER"),
      authority = setting("PRJ_AUTHORITY"),
      clientId = setting("PRJ_CLIENT_ID"),
      scope = setting("PRJ_API_SCOPE");
    if (!server || !authority || !clientId || !scope || !uuid.test(clientId))
      throw new Error();
    const origin = new URL(server),
      provider = new URL(authority);
    const allowLoopbackHttp = env.PRJ_ALLOW_LOOPBACK_HTTP === "1";
    const tenantId = provider.pathname.replace(/^\//, "").replace(/\/$/, "");
    if (
      /[\s\\]/.test(server + authority) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      (origin.protocol !== "https:" &&
        !(
          allowLoopbackHttp &&
          origin.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(origin.hostname)
        )) ||
      provider.protocol !== "https:" ||
      provider.username ||
      provider.password ||
      provider.port ||
      provider.search ||
      provider.hash ||
      !/^[a-z0-9-]+\.ciamlogin\.com$/.test(provider.hostname) ||
      !uuid.test(tenantId) ||
      !/^api:\/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[A-Za-z][A-Za-z0-9_.-]{0,99}$/i.test(
        scope,
      )
    )
      throw new Error();
    return {
      origin: origin.origin,
      authority: `${provider.origin}/${tenantId.toLowerCase()}`,
      tenantId: tenantId.toLowerCase(),
      clientId: clientId.toLowerCase(),
      scope,
      allowLoopbackHttp,
    };
  } catch {
    throw new LoginError(
      "Configure PRJ_SERVER, PRJ_AUTHORITY, PRJ_CLIENT_ID and PRJ_API_SCOPE with the registered PrjLab applications, or unset them to use https://prjlab.com. No client secret is required.",
    );
  }
}
export function credentialScope(config: LoginConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.origin,
        config.authority,
        config.clientId,
        config.scope,
      ]),
    )
    .digest("hex");
}
