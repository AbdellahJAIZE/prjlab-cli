import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicClientApplication } from "@azure/msal-node";
import { randomUUID } from "node:crypto";
const tenant = "11111111-1111-4111-8111-111111111111";
const client = "22222222-2222-4222-8222-222222222222";
const origin = "https://example.ciamlogin.com";
const authority = `${origin}/${tenant}`;
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const scope = "api://33333333-3333-4333-8333-333333333333/access_as_user";
for (const validNonce of [true, false]) {
  test(`real MSAL code exchange ${validNonce ? "accepts" : "rejects"} nonce fixture`, async () => {
    let exchange;
    const metadata = {
      issuer: `${authority}/v2.0`,
      authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
      token_endpoint: `${authority}/oauth2/v2.0/token`,
      end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
      jwks_uri: `${authority}/discovery/v2.0/keys`,
    };
    const networkClient = {
      sendGetRequestAsync: async () => {
        throw new Error("Unexpected network discovery");
      },
      sendPostRequestAsync: async (url, options) => {
        assert.equal(
          new URL(url).origin + new URL(url).pathname,
          metadata.token_endpoint,
        );
        exchange = new URLSearchParams(options.body);
        const now = Math.floor(Date.now() / 1000);
        const payload = {
          aud: client,
          iss: metadata.issuer,
          iat: now,
          nbf: now,
          exp: now + 3600,
          sub: "subject",
          oid: "44444444-4444-4444-8444-444444444444",
          tid: tenant,
          nonce: validNonce ? "expected-nonce" : "wrong-nonce",
          ver: "2.0",
        };
        return {
          status: 200,
          headers: {},
          body: {
            token_type: "Bearer",
            scope,
            expires_in: 3600,
            access_token: "synthetic.access.signature",
            refresh_token: "synthetic-refresh",
            id_token: `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.synthetic-signature`,
            client_info: encode({ uid: payload.oid, utid: tenant }),
          },
        };
      },
    };
    const pca = new PublicClientApplication({
      auth: {
        clientId: client,
        authority,
        knownAuthorities: [new URL(origin).hostname],
        authorityMetadata: JSON.stringify(metadata),
      },
      system: {
        networkClient,
        disableInternalRetries: true,
        loggerOptions: { loggerCallback: () => {}, piiLoggingEnabled: false },
      },
    });
    const state = randomUUID();
    const url = new URL(
      await pca.getAuthCodeUrl({
        scopes: [scope],
        redirectUri: "http://localhost:32100",
        state,
        nonce: "expected-nonce",
        codeChallenge: "a".repeat(43),
        codeChallengeMethod: "S256",
        responseMode: "query",
      }),
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), state);
    assert.equal(url.searchParams.get("nonce"), "expected-nonce");
    const result = pca.acquireTokenByCode({
      scopes: [scope],
      redirectUri: "http://localhost:32100",
      code: "synthetic-code",
      codeVerifier: "verifier".repeat(8),
      nonce: "expected-nonce",
      state,
    });
    if (validNonce) {
      const token = await result;
      assert.equal(token.accessToken, "synthetic.access.signature");
      assert.equal(token.account.tenantId, tenant);
      assert.ok(pca.getTokenCache().serialize().includes("synthetic-refresh"));
    } else await assert.rejects(result, /nonce/i);
    assert.equal(exchange.get("grant_type"), "authorization_code");
    assert.equal(exchange.get("code_verifier"), "verifier".repeat(8));
    assert.equal(exchange.has("client_secret"), false);
  });
}
