import type {
  INetworkModule,
  NetworkRequestOptions,
  NetworkResponse,
} from "@azure/msal-node";
import { LoginError } from "./auth-config.js";
/** Provider discovery and token traffic is confined to the configured tenant host. */
export class IdentityNetwork implements INetworkModule {
  constructor(
    private readonly origin: string,
    private readonly signal: AbortSignal,
  ) {}
  sendGetRequestAsync<T>(
    url: string,
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    return this.send<T>("GET", url, options);
  }
  sendPostRequestAsync<T>(
    url: string,
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    return this.send<T>("POST", url, options);
  }
  private async send<T>(
    method: string,
    value: string,
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const url = new URL(value);
      if (
        url.origin !== this.origin ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        Buffer.byteLength(options?.body ?? "") > 65536
      )
        throw new Error();
      const response = await fetch(url, {
        method,
        headers: options?.headers,
        body: options?.body,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.any([this.signal, controller.signal]),
      });
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        ) ||
        !response.body
      )
        throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(value);
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: JSON.parse(text) as T,
      };
    } catch {
      throw new LoginError(
        "The identity provider request failed. No credential details were logged.",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
