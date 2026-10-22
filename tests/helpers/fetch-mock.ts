import { vi } from "vitest";

export type RecordedCall = {
  url: string;
  body: unknown;
};

const realFetch = globalThis.fetch.bind(globalThis);

export function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return realFetch(input as RequestInfo, init);
      }

      let body: unknown = init?.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          // keep the raw body
        }
      }
      calls.push({ url, body });

      if (url.includes("elevenlabs.io")) {
        return new Response(JSON.stringify({ text: "mocked transcript" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("graph.facebook.com")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected network call to ${url}`);
    }),
  );
  return calls;
}
