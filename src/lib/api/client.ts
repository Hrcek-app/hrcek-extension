import { errorFromResponse, HrcekApiError, HrcekNetworkError } from './errors';
import type {
  EntryIn,
  EntryLookupIn,
  EntryOut,
  FieldOut,
  HealthOut,
  LabelOut,
  PagedFieldOut,
  PagedLabelOut,
  TokenOut,
  UserOut,
} from './types';

export type SaveResult = { status: 'created' | 'updated'; entry: EntryOut };

/** Thin typed wrapper over the Hrček HTTP API. */
export class HrcekClient {
  constructor(
    /** e.g. "https://hrcek.example.com" — no trailing slash. */
    private readonly baseUrl: string,
    /** Bearer token, or null when only anonymous calls are needed. */
    private readonly token: string | null,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
    /**
     * The language to ask the server's messages in. Codes never change,
     * so this changes only what a person reads. Unset sends no header,
     * and the server answers in its own default.
     */
    private readonly clientOptions: { acceptLanguage?: string } = {},
  ) {}

  async health(): Promise<HealthOut> {
    return (await this.request('GET', '/api/health')).json();
  }

  async me(): Promise<UserOut> {
    return (await this.request('GET', '/api/auth/me')).json();
  }

  /**
   * Trade credentials for a bearer token. This is the route for clients
   * that cannot hold a session — an extension cannot, because Django
   * rejects `moz-extension://` origins before reading anything else.
   *
   * Sent anonymously: the route reads no session and needs no token, and
   * presenting one here would say nothing about who is asking.
   */
  async createToken(
    name: string,
    identifier: string,
    password: string,
  ): Promise<TokenOut> {
    // No expires_at: the extension's token should keep working.
    const response = await this.request(
      'POST',
      '/api/auth/tokens/exchange',
      { name, identifier, password },
      { anonymous: true },
    );
    return response.json();
  }

  /**
   * The entry held at an address, for looking before writing. 404 with
   * `HRC-CORE-0003` means you do not hold it — which is also what somebody
   * else holding it answers, deliberately: a 403 would reveal that they do.
   *
   * A POST for a read, and the address travels in the body: an address is
   * the private half of an entry, and a query string is written into every
   * access log, proxy and error report the request passes through. Hrček
   * logs the path and never the query string, but the hops in front of it
   * are not Hrček's to control.
   */
  async getEntryByUrl(url: string): Promise<EntryOut> {
    const body: EntryLookupIn = { url };
    return (await this.request('POST', '/api/entries/lookup', body)).json();
  }

  /**
   * The fields this account's entries may carry. `name` is the key an
   * entry's `fields` object uses, so what is read here is what gets
   * written back — never hard-code these.
   */
  async listFields(): Promise<FieldOut[]> {
    const page = (await (
      await this.request('GET', '/api/fields/')
    ).json()) as PagedFieldOut;
    return page.items;
  }

  /**
   * This account's labels, alphabetically. `startsWith` narrows them and
   * is matched as a literal; `after` is a cursor, not an offset — pass
   * the last name served to get the next page.
   */
  async listLabels(
    options: { startsWith?: string; after?: string } = {},
  ): Promise<LabelOut[]> {
    const query = new URLSearchParams();
    // Sent only when they say something. The server defaults both to "",
    // so an empty parameter is noise on every keystroke.
    if (options.startsWith) query.set('starts_with', options.startsWith);
    if (options.after) query.set('after', options.after);
    const suffix = query.size > 0 ? `?${query}` : '';
    const page = (await (
      await this.request('GET', `/api/labels/${suffix}`)
    ).json()) as PagedLabelOut;
    return page.items;
  }

  /** Upsert. 201 → created, 200 → updated (replace-except-fields semantics). */
  async saveEntry(entry: EntryIn): Promise<SaveResult> {
    const response = await this.request('POST', '/api/entries/', entry);
    return {
      status: response.status === 201 ? 'created' : 'updated',
      entry: await response.json(),
    };
  }

  /**
   * The bytes behind an entry's `image.url`. That address answers only to
   * the account owning the entry, so it needs the token like every other
   * call — and an `<img src>` cannot carry one, which is why a picture is
   * fetched here and shown from an object URL instead.
   *
   * `path` is the server-relative address the entry itself carried; it is
   * not under `/api/`.
   */
  async fetchImage(path: string): Promise<Blob> {
    // A refusal comes back as the JSON envelope even here, so both types
    // are acceptable. AVIF must be named to be sent; `image/*` gets WebP.
    const response = await this.request('GET', path, undefined, {
      accept: 'image/avif, image/*, application/json',
    });
    // A server from before this address took tokens redirects to its
    // sign-in page, which fetch follows to a 200 of HTML.
    if (!(response.headers.get('Content-Type') ?? '').startsWith('image/')) {
      throw new HrcekApiError(
        response.status,
        'HRC-CLIENT-NOT-A-PICTURE',
        `The server answered ${path} with something other than a picture.`,
      );
    }
    return response.blob();
  }

  /** Replaces whatever picture the entry had. Multipart, not JSON. */
  async uploadImage(id: number, bytes: Blob, filename: string): Promise<EntryOut> {
    const form = new FormData();
    form.set('file', bytes, filename);
    return (await this.request('POST', `/api/entries/${id}/image`, form)).json();
  }

  /** The only way to remove a picture; a POST cannot do it. 204, no body. */
  async deleteImage(id: number): Promise<void> {
    await this.request('DELETE', `/api/entries/${id}/image`);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: { anonymous?: boolean; accept?: string } = {},
  ): Promise<Response> {
    const authenticated = !options.anonymous && this.token !== null;
    const isForm = body instanceof FormData;
    const headers: Record<string, string> = {
      // Every route but the picture answers JSON; a refusal is JSON even
      // from the picture route, and errorFromResponse reads it as such.
      Accept: options.accept ?? 'application/json',
      ...(this.clientOptions.acceptLanguage !== undefined
        ? { 'Accept-Language': this.clientOptions.acceptLanguage }
        : {}),
      // FormData sets its own Content-Type, boundary and all. Setting it
      // by hand produces a body the server cannot parse.
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}),
    };
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        // Cookies are never used: session auth cannot pass Django's CSRF
        // origin check from an extension, so bearer tokens are the only
        // credential this client understands.
        credentials: 'omit',
        body:
          body === undefined
            ? undefined
            : isForm
              ? (body as FormData)
              : JSON.stringify(body),
      });
    } catch (cause) {
      throw new HrcekNetworkError(`Could not reach ${this.baseUrl}.`, { cause });
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }
}
