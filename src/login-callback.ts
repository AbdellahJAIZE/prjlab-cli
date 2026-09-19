import { createServer } from "node:http";
import { LoginError } from "./auth-config.js";
/** Own the callback listener so cancellation and invalid-state handling are explicit. */
export async function loginCallback(state: string, signal: AbortSignal) {
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  let used = false;
  let expectedHost = "";
  const code = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A timeout can precede the caller awaiting the code while opening a browser.
  void code.catch(() => {});
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    const fail = () => {
      res.writeHead(400);
      res.end("Invalid login callback.");
    };
    if (
      used ||
      signal.aborted ||
      req.method !== "GET" ||
      req.headers.host !== expectedHost ||
      !req.url?.startsWith("/") ||
      req.url.startsWith("//") ||
      req.url.length > 8192
    )
      return fail();
    const url = new URL(req.url, `http://${expectedHost}`);
    if (
      url.pathname !== "/" ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.get("state") !== state
    )
      return fail();
    const codes = url.searchParams.getAll("code"),
      errors = url.searchParams.getAll("error");
    if (errors.length === 1 && codes.length === 0) {
      used = true;
      res.writeHead(400);
      res.end("Sign-in was not completed. Return to the terminal.");
      reject(new LoginError("Sign-in was declined or failed."));
      return;
    }
    if (
      codes.length !== 1 ||
      errors.length ||
      !codes[0] ||
      codes[0].length > 4096
    )
      return fail();
    used = true;
    res.end(
      "Authorization received. Return to the terminal to finish signing in.",
    );
    resolve(codes[0]);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  const abort = () => {
    used = true;
    reject(new LoginError("Sign-in was cancelled or timed out."));
    close();
  };
  if (signal.aborted)
    throw new LoginError("Sign-in was cancelled or timed out.");
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", no);
      yes();
    });
  });
  server.on("error", () => {
    reject(new LoginError("Local sign-in callback failed."));
    close();
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    close();
    throw new LoginError("Local sign-in callback failed.");
  }
  expectedHost = `localhost:${address.port}`;
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    redirectUri: `http://${expectedHost}`,
    code,
    close: () => {
      signal.removeEventListener("abort", abort);
      close();
    },
  };
}
