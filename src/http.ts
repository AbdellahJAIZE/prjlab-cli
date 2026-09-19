/** Bounded transport only. Callers must validate response data against the API contract. */
export type TransportCode =
  | "configuration"
  | "authentication"
  | "permission"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "service"
  | "http"
  | "redirect"
  | "response"
  | "request"
  | "timeout"
  | "cancelled"
  | "network";
const messages: Record<TransportCode, string> = {
  configuration: "Invalid API origin, credential scope or transport limits.",
  authentication: "Sign in again to access PrjLab.",
  permission: "This account does not have the required permission.",
  not_found: "The requested account or resource is unavailable.",
  conflict: "The operation conflicts with the current server state.",
  rate_limited: "The server limit was reached. Try again later.",
  service: "The service is temporarily unavailable.",
  http: "The server rejected the request.",
  redirect: "The API redirected the request. Credentials were not forwarded.",
  response: "The API returned an invalid or oversized response.",
  request: "The API request is invalid or too large.",
  timeout: "The API request timed out.",
  cancelled: "The API request was cancelled.",
  network: "Could not reach the API securely.",
};
export class TransportError extends Error {
  constructor(
    readonly code: TransportCode,
    readonly status?: number,
  ) {
    super(messages[code]);
    this.name = "TransportError";
  }
}
export interface ApiCredential {
  origin: string;
  accessToken: string;
}
interface TransportOptions {
  /** Explicit opt-in for isolated loopback tests; never enables remote HTTP. */
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
function origin(value: string, allowLoopback: boolean): string {
  try {
    if (typeof value !== "string" || /[\s\x00-\x1f\x7f]/.test(value))
      throw new Error();
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          allowLoopback &&
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new TransportError("configuration");
  }
}
export class ApiTransport {
  #origin: string;
  #token: string;
  #timeout: number;
  #limit: number;
  constructor(
    server: string,
    credential: ApiCredential,
    options: TransportOptions = {},
  ) {
    const loopback = options.allowLoopbackHttp === true;
    this.#origin = origin(server, loopback);
    this.#token = credential.accessToken;
    this.#timeout = options.timeoutMs ?? 10000;
    this.#limit = options.maxResponseBytes ?? 1024 * 1024;
    if (
      origin(credential.origin, loopback) !== this.#origin ||
      typeof this.#token !== "string" ||
      this.#token.length > 16384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(this.#token) ||
      !Number.isSafeInteger(this.#timeout) ||
      this.#timeout < 1 ||
      this.#timeout > 30000 ||
      !Number.isSafeInteger(this.#limit) ||
      this.#limit < 1 ||
      this.#limit > 1024 * 1024
    )
      throw new TransportError("configuration");
  }
  async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    route: string,
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<{ status: number; data: unknown }> {
    // No arbitrary URLs, percent-encoded path tricks, queries or redirects.
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      !/^\/api\/v1(?:\/[A-Za-z0-9_-]+)+$/.test(route) ||
      route.length > 2048 ||
      (method === "GET" && options.body !== undefined)
    )
      throw new TransportError("request");
    let body: string | undefined;
    try {
      if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        if (body === undefined || Buffer.byteLength(body) > 64 * 1024)
          throw new Error();
      }
    } catch {
      throw new TransportError("request");
    }
    if (options.signal?.aborted) throw new TransportError("cancelled");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeout);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    try {
      const response = await fetch(this.#origin + route, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal,
      });
      if (response.status >= 300 && response.status < 400)
        throw new TransportError("redirect", response.status);
      if (!response.ok) {
        const codes: Record<number, TransportCode> = {
          401: "authentication",
          403: "permission",
          404: "not_found",
          409: "conflict",
          429: "rate_limited",
        };
        throw new TransportError(
          codes[response.status] ??
            (response.status >= 500 ? "service" : "http"),
          response.status,
        );
      }
      if (response.status === 204) return { status: 204, data: undefined };
      const length = response.headers.get("content-length");
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        ) ||
        (length !== null &&
          (!/^\d+$/.test(length) || Number(length) > this.#limit)) ||
        !response.body
      )
        throw new TransportError("response", response.status);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.#limit)
          throw new TransportError("response", response.status);
        chunks.push(value);
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        );
        return { status: response.status, data: JSON.parse(text) as unknown };
      } catch {
        throw new TransportError("response", response.status);
      }
    } catch (error) {
      if (options.signal?.aborted) throw new TransportError("cancelled");
      if (timedOut) throw new TransportError("timeout");
      if (error instanceof TransportError) throw error;
      // Do not expose fetch error causes, URLs, request headers or server bodies.
      throw new TransportError("network");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
