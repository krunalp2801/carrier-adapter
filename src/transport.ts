/**
 * The seam. Every adapter talks to a `Transport`, never to `fetch`.
 *
 * This is what makes the adapters testable without a network and without
 * stubbing a global, and it is what the sandboxes plug into. A test can
 * assert the exact bytes an adapter sends, which for the SOAP one matters:
 * a misplaced element in a DPD envelope is rejected with a message that does
 * not say which element.
 */

export interface TransportRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

/** Real HTTP. `fetchImpl` is injectable so even this is testable. */
export function httpTransport(fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Transport {
  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init: RequestInit = {
          method: request.method,
          headers: request.headers,
          signal: controller.signal,
        };
        if (request.body !== undefined) init.body = request.body;
        const res = await fetchImpl(request.url, init);
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return { status: res.status, headers, body: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Transport that records what it was asked to send. Used in tests. */
export function recordingTransport(inner: Transport): Transport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  return {
    sent,
    async send(request: TransportRequest): Promise<TransportResponse> {
      sent.push(request);
      return inner.send(request);
    },
  };
}
