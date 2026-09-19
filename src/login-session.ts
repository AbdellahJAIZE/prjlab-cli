import {
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type AuthorizationUrlRequest,
  type AuthorizationCodeRequest,
  type SilentFlowRequest,
} from "@azure/msal-node";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  credentialScope,
  LoginError,
  type LoginConfig,
} from "./auth-config.js";
import { type CredentialStore } from "./credential-store.js";
import { loginCallback } from "./login-callback.js";
import { IdentityNetwork } from "./identity-network.js";
import { ApiTransport, TransportError } from "./http.js";
export interface AuthClient {
  getAuthCodeUrl(request: AuthorizationUrlRequest): Promise<string>;
  acquireTokenByCode(
    request: AuthorizationCodeRequest,
  ): Promise<AuthenticationResult>;
  acquireTokenSilent(request: SilentFlowRequest): Promise<AuthenticationResult>;
  getTokenCache(): {
    serialize(): string;
    deserialize(value: string): void;
    getAllAccounts(): Promise<AccountInfo[]>;
  };
}
interface SavedSession {
  version: 1;
  scope: string;
  accountId: string;
  cache: string;
}
export type AccountResult = { id: string; handle: string };
export interface LoginDependencies {
  client(config: LoginConfig, signal: AbortSignal): AuthClient;
  openBrowser(url: string, signal: AbortSignal): Promise<void>;
  verify(
    config: LoginConfig,
    token: string,
    signal: AbortSignal,
  ): Promise<AccountResult>;
}
export const loginDependencies: LoginDependencies = {
  client: (config, signal) =>
    new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: config.authority,
        knownAuthorities: [new URL(config.authority).hostname],
      },
      system: {
        disableInternalRetries: true,
        networkClient: new IdentityNetwork(
          new URL(config.authority).origin,
          signal,
        ),
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
      },
    }),
  openBrowser: async (url, signal) => {
    const command =
      process.platform === "win32"
        ? "rundll32.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    const args =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", url]
        : [url];
    try {
      await promisify(execFile)(command, args, {
        signal,
        timeout: 10000,
        maxBuffer: 65536,
        windowsHide: true,
      });
    } catch {
      throw new LoginError(
        "Could not open the system browser. Check your desktop browser setup and retry.",
      );
    }
  },
  verify: async (config, token, signal) => {
    const api = new ApiTransport(
      config.origin,
      { origin: config.origin, accessToken: token },
      { allowLoopbackHttp: config.allowLoopbackHttp },
    );
    try {
      const { data } = await api.request("GET", "/api/v1/account", { signal });
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
      const account = data as Record<string, unknown>;
      if (
        Object.keys(account).sort().join(",") !== "handle,id" ||
        typeof account.id !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(account.id) ||
        typeof account.handle !== "string" ||
        !/^[a-z][a-z0-9-]{2,38}$/.test(account.handle)
      )
        throw new Error();
      return { id: account.id, handle: account.handle };
    } catch (error) {
      if (error instanceof TransportError && error.status === 404)
        throw new LoginError(
          "Complete account setup in the PrjLab web app, then run prj login again. Existing saved credentials were kept.",
        );
      throw new LoginError(
        "PrjLab could not verify this sign-in. Existing saved credentials were not replaced.",
      );
    }
  },
};
export class LoginSession {
  constructor(
    private readonly config: LoginConfig,
    private readonly store: CredentialStore,
    private readonly deps: LoginDependencies = loginDependencies,
  ) {}
  private async save(client: AuthClient, result: AuthenticationResult) {
    const previous = await this.store.load();
    const next = JSON.stringify({
      version: 1,
      scope: credentialScope(this.config),
      accountId: result.account!.homeAccountId,
      cache: client.getTokenCache().serialize(),
    } satisfies SavedSession);
    if (Buffer.byteLength(next) > 4 * 1024 * 1024)
      throw new LoginError(
        "Credential cache exceeds the supported size. Existing credentials were kept.",
      );
    try {
      await this.store.save(next);
      if ((await this.store.load()) !== next) throw new Error();
    } catch {
      try {
        if (previous === null) await this.store.delete();
        else await this.store.save(previous);
        if ((await this.store.load()) !== previous) throw new Error();
      } catch {
        throw new LoginError(
          "Secure credential storage failed during recovery. Check the OS store and sign in again.",
        );
      }
      throw new LoginError(
        "Secure credential update failed. Previous credentials were restored.",
      );
    }
  }
  private async verified(result: AuthenticationResult, signal: AbortSignal) {
    if (
      !result.account ||
      result.account.tenantId.toLowerCase() !== this.config.tenantId ||
      !result.account.homeAccountId ||
      !result.accessToken ||
      !result.expiresOn ||
      result.expiresOn.getTime() <= Date.now() + 10000
    )
      throw new LoginError(
        "The identity provider did not return a usable account and API token.",
      );
    return this.deps.verify(this.config, result.accessToken, signal);
  }
  async login(signal: AbortSignal): Promise<AccountResult> {
    const client = this.deps.client(this.config, signal);
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    const callback = await loginCallback(state, signal);
    try {
      const url = await client.getAuthCodeUrl({
        scopes: [this.config.scope],
        redirectUri: callback.redirectUri,
        state,
        nonce,
        codeChallenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        codeChallengeMethod: "S256",
        responseMode: "query",
        prompt: "select_account",
      });
      const target = new URL(url);
      if (
        target.origin !== new URL(this.config.authority).origin ||
        target.username ||
        target.password ||
        target.hash
      )
        throw new LoginError("Unexpected authorization destination.");
      signal.throwIfAborted();
      await this.deps.openBrowser(url, signal);
      const code = await callback.code;
      signal.throwIfAborted();
      const result = await client.acquireTokenByCode({
        scopes: [this.config.scope],
        redirectUri: callback.redirectUri,
        code,
        codeVerifier: verifier,
        nonce,
        state,
      });
      const account = await this.verified(result, signal);
      signal.throwIfAborted();
      await this.save(client, result);
      return account;
    } catch (error) {
      if (signal.aborted)
        throw new LoginError(
          "Sign-in was cancelled or timed out. Existing credentials were kept.",
        );
      if (error instanceof LoginError) throw error;
      throw new LoginError(
        "Sign-in failed. Existing credentials were kept; no provider error details were logged.",
      );
    } finally {
      callback.close();
    }
  }
  async whoami(signal: AbortSignal): Promise<AccountResult> {
    try {
      const raw = await this.store.load();
      if (!raw) throw new LoginError("Not signed in. Run prj login.");
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error();
      const saved = JSON.parse(raw) as SavedSession;
      if (
        saved.version !== 1 ||
        saved.scope !== credentialScope(this.config) ||
        typeof saved.accountId !== "string" ||
        typeof saved.cache !== "string"
      )
        throw new Error();
      const client = this.deps.client(this.config, signal);
      client.getTokenCache().deserialize(saved.cache);
      const accounts = await client.getTokenCache().getAllAccounts();
      const account = accounts.find(
        (a) =>
          a.homeAccountId === saved.accountId &&
          a.tenantId.toLowerCase() === this.config.tenantId,
      );
      if (!account) throw new Error();
      const result = await client.acquireTokenSilent({
        account,
        scopes: [this.config.scope],
      });
      if (result.account?.homeAccountId !== saved.accountId) throw new Error();
      const verified = await this.verified(result, signal);
      signal.throwIfAborted();
      await this.save(client, result);
      return verified;
    } catch (error) {
      if (signal.aborted)
        throw new LoginError("Account check was cancelled or timed out.");
      if (error instanceof LoginError) throw error;
      throw new LoginError(
        "Saved sign-in is unavailable or expired. Run prj login again.",
      );
    }
  }
  async logout() {
    await this.store.delete();
  }
}
