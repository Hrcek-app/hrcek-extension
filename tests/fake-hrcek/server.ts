// A small in-memory Hrček good enough for e2e and contract tests.
// Behavior mirrors ../hrcek/docs/dev/api.md; responses are typed against
// the generated schema so the fake cannot quietly drift from it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EntryOut, HealthOut, UserOut } from '../../src/lib/api/types';

export const FAKE_TOKEN = 'hrcek_test_token';
export const FAKE_IDENTIFIER = 'nina@example.com';
export const FAKE_PASSWORD = 'correct horse';
export const FAKE_USER: UserOut = { email: 'nina@example.com', display_name: null };

const SESSION_ID = 'fake-session';
const CSRF_TOKEN = 'fake-csrf';
/** ApiToken.NAME_MAX_LENGTH on the real server. */
const TOKEN_NAME_MAX_LENGTH = 50;
export const MINTED_TOKEN_PREFIX = 'hrcek_minted_';
/** Both the default and the maximum, as the real server publishes it. */
const LABELS_PER_PAGE = 1000;

/**
 * An address no Hrček can fetch, standing in for the everyday cases — a
 * signed URL, a referer check, a host that has gone away. Subdomains of
 * `example.com` never resolve, so the real server answers HRC-IMAGE-0006
 * for this one too, with `details.host`.
 */
export const UNFETCHABLE_IMAGE_HOST = 'unfetchable.example.com';
export const UNFETCHABLE_IMAGE_URL = `https://${UNFETCHABLE_IMAGE_HOST}/picture.jpg`;

/** One transparent pixel, which is all any of this needs to be a picture. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A fresh Hrček account's default fields, in the shape GET /api/fields/ serves. */
const ACCOUNT_FIELDS = [
  { name: 'Price', kind: 'number' as const, options: [] as string[] },
  {
    name: 'Priority',
    kind: 'choice' as const,
    options: ['high', 'medium', 'low'],
  },
];

export interface FakeHrcek {
  url: string;
  reset(): void;
  close(): Promise<void>;
}

interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

function errorBody(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ErrorBody {
  return { error: { code, message, details } };
}

/**
 * The real server translates messages and falls back to English for a
 * language it does not carry (../hrcek/docs/dev/api.md, "Languages").
 * One message is enough to prove a client asked in the right language.
 */
const TRANSLATIONS: Record<string, Record<string, string>> = {
  sl: { 'HRC-CORE-0003': 'Zahtevani vir ne obstaja.' },
};

function languageOf(req: http.IncomingMessage): string {
  // Good enough for a fake: the first tag, without its quality weight.
  const header = req.headers['accept-language'] ?? '';
  return header.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
}

function translate(req: http.IncomingMessage, body: ErrorBody): ErrorBody {
  const message = TRANSLATIONS[languageOf(req)]?.[body.error.code];
  if (message === undefined) return body;
  return { error: { ...body.error, message } };
}

/** Whitespace trimmed, scheme and host lowercased — and nothing else. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(.*)$/.exec(trimmed);
  if (match === null) return trimmed;
  return `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}${match[3]!}`;
}

function isValidUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether this is the address the fake refuses to fetch. */
function isUnfetchable(imageUrl: string): boolean {
  try {
    return new URL(imageUrl).hostname.endsWith(UNFETCHABLE_IMAGE_HOST);
  } catch {
    return false;
  }
}

/** "129.00" -> "129", "38.50" -> "38.5" — the way it was most likely typed. */
function normalizeNumber(value: string): string {
  return String(Number(value));
}

export async function startFakeHrcek(port = 0): Promise<FakeHrcek> {
  let entries = new Map<string, EntryOut>();
  let nextId = 1;
  let outage = false;
  let nextTokenId = 1;
  let clock = 0;

  function timestamp(): string {
    clock += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function parseCookies(req: http.IncomingMessage): Record<string, string> {
    const header = req.headers.cookie ?? '';
    const cookies: Record<string, string> = {};
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name) cookies[name] = rest.join('=');
    }
    return cookies;
  }

  /** Returns null when authenticated; an error response description otherwise. */
  function checkAuth(
    req: http.IncomingMessage,
  ): { status: number; body: ErrorBody } | null {
    const auth = req.headers.authorization ?? '';
    if (auth === `Bearer ${FAKE_TOKEN}`) return null;
    // Tokens handed out by POST /api/auth/tokens work like any other.
    if (auth.startsWith(`Bearer ${MINTED_TOKEN_PREFIX}`)) return null;
    const cookies = parseCookies(req);
    if (cookies['sessionid'] === SESSION_ID) {
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
      if (unsafe && req.headers['x-csrftoken'] !== cookies['csrftoken']) {
        return {
          status: 403,
          body: errorBody('HRC-AUTH-0005', 'CSRF check failed.'),
        };
      }
      return null;
    }
    return {
      status: 401,
      body: errorBody('HRC-AUTH-0003', 'You must sign in to do that.'),
    };
  }

  function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => (data += chunk.toString()));
      req.on('end', () => {
        try {
          resolve(data.length > 0 ? JSON.parse(data) : {});
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  /** Returns the updated fields or an error. Implements patch semantics. */
  function applyFields(
    current: Record<string, string>,
    submitted: Record<string, unknown>,
  ): { fields: Record<string, string> } | { status: number; body: ErrorBody } {
    const result = { ...current };
    for (const [rawName, rawValue] of Object.entries(submitted)) {
      const definition = ACCOUNT_FIELDS.find(
        (field) => field.name.toLowerCase() === rawName.trim().toLowerCase(),
      );
      if (definition === undefined) {
        return {
          status: 422,
          body: errorBody('HRC-FIELD-0001', 'There is no field with that name.', {
            field: rawName,
          }),
        };
      }
      const value = String(rawValue);
      if (value === '') {
        delete result[definition.name];
        continue;
      }
      if (definition.kind === 'number' && Number.isNaN(Number(value))) {
        return {
          status: 422,
          body: errorBody('HRC-CORE-0002', 'The submitted data is not valid.', {
            fields: { [definition.name]: ['This field takes a number.'] },
          }),
        };
      }
      if (definition.kind === 'choice' && !definition.options.includes(value)) {
        return {
          status: 422,
          body: errorBody('HRC-CORE-0002', 'The submitted data is not valid.', {
            fields: {
              [definition.name]: [
                `This field must be one of: ${definition.options.join(', ')}.`,
              ],
            },
          }),
        };
      }
      result[definition.name] =
        definition.kind === 'number' ? normalizeNumber(value) : value;
    }
    return { fields: result };
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      const route = `${req.method} ${requestUrl.pathname}`;

      if (route === 'POST /__outage') {
        outage = true;
        res.writeHead(204).end();
        return;
      }
      if (route === 'POST /__restore') {
        outage = false;
        res.writeHead(204).end();
        return;
      }
      // What a reverse proxy says in front of a stopped Hrček: an HTML
      // page, not the error envelope — so the client sees it unparseable.
      if (outage && !requestUrl.pathname.startsWith('/__')) {
        res
          .writeHead(503, { 'Content-Type': 'text/html' })
          .end('<h1>503 Service Unavailable</h1>');
        return;
      }

      if (route === 'POST /__reset') {
        entries = new Map();
        nextId = 1;
        outage = false;
        res.writeHead(204).end();
        return;
      }

      if (route === 'GET /api/health') {
        const body: HealthOut = {
          status: 'ok',
          service: 'fake-hrcek',
          version: '0.0.0',
          message: 'Service is running.',
        };
        return json(res, 200, body);
      }

      if (route === 'POST /api/auth/login') {
        const body = (await readBody(req)) as {
          identifier?: string;
          password?: string;
        };
        if (body.identifier !== FAKE_IDENTIFIER || body.password !== FAKE_PASSWORD) {
          return json(res, 401, errorBody('HRC-AUTH-0001', 'Invalid credentials.'));
        }
        res.setHeader('Set-Cookie', [
          `sessionid=${SESSION_ID}; Path=/`,
          `csrftoken=${CSRF_TOKEN}; Path=/`,
        ]);
        return json(res, 200, FAKE_USER);
      }

      // Credentials traded for a token, for clients that cannot hold a
      // session. The real route is declared auth=None, so it reads no
      // session and ignores any Authorization header it is handed.
      if (route === 'POST /api/auth/tokens/exchange') {
        const body = (await readBody(req)) as {
          name?: string;
          identifier?: string;
          password?: string;
        };
        const name = (body.name ?? '').trim();
        if (name === '' || name.length > TOKEN_NAME_MAX_LENGTH) {
          return json(
            res,
            422,
            errorBody('HRC-CORE-0002', 'The submitted data is not valid.', {
              fields: { name: ['Give the token a name.'] },
            }),
          );
        }
        if (body.identifier !== FAKE_IDENTIFIER || body.password !== FAKE_PASSWORD) {
          return json(res, 401, errorBody('HRC-AUTH-0001', 'Invalid credentials.'));
        }
        return json(res, 201, {
          id: nextTokenId++,
          name,
          token: `${MINTED_TOKEN_PREFIX}${nextTokenId}`,
          created_at: timestamp(),
          expires_at: null,
        });
      }

      // GET / stands in for any page that makes Django set the CSRF cookie.
      if (route === 'GET /') {
        res.setHeader('Set-Cookie', [`csrftoken=${CSRF_TOKEN}; Path=/`]);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>fake hrcek</html>');
      }

      const authError = checkAuth(req);
      if (authError !== null) return json(res, authError.status, authError.body);

      if (route === 'GET /api/auth/me') {
        return json(res, 200, FAKE_USER);
      }

      // A POST for a read: the address is the private half of an entry and
      // must stay out of query strings, which every access log records.
      if (route === 'POST /api/entries/lookup') {
        const body = (await readBody(req)) as { url?: unknown };
        const url = typeof body.url === 'string' ? body.url : '';
        const entry = entries.get(normalizeUrl(url));
        if (entry === undefined) {
          return json(
            res,
            404,
            translate(
              req,
              errorBody('HRC-CORE-0003', 'The requested resource does not exist.', {
                url,
              }),
            ),
          );
        }
        return json(res, 200, entry);
      }

      if (route === 'GET /api/fields/') {
        return json(res, 200, {
          items: ACCOUNT_FIELDS,
          count: ACCOUNT_FIELDS.length,
        });
      }

      if (route === 'GET /api/labels/') {
        const limit = Number(requestUrl.searchParams.get('limit') ?? LABELS_PER_PAGE);
        if (!Number.isInteger(limit) || limit < 1 || limit > LABELS_PER_PAGE) {
          return json(
            res,
            422,
            errorBody('HRC-CORE-0002', 'The submitted data is not valid.', {
              fields: {
                limit: [`Ensure this value is less than or equal to ${LABELS_PER_PAGE}.`],
              },
            }),
          );
        }
        // Only labels some entry carries: the real server deletes a tag
        // when the last entry using it lets go.
        const names = new Set<string>();
        for (const entry of entries.values())
          for (const tag of entry.tags) names.add(tag);

        const prefix = (requestUrl.searchParams.get('starts_with') ?? '')
          .trim()
          .toLowerCase();
        const after = (requestUrl.searchParams.get('after') ?? '').trim().toLowerCase();
        // Ordering and cursor both use the lowercased name so they agree
        // exactly; two labels cannot differ only by case, so no ties.
        const matching = [...names]
          .filter((name) => name.toLowerCase().startsWith(prefix))
          .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
        const page = matching
          .filter((name) => name.toLowerCase() > after)
          .slice(0, limit);

        return json(res, 200, {
          items: page.map((name) => ({ name })),
          // How many match, not how many this page carries.
          count: matching.length,
        });
      }

      if (route === 'POST /api/entries/') {
        const body = (await readBody(req)) as {
          url?: string;
          title?: string;
          notes?: string;
          tags?: string[];
          fields?: Record<string, unknown> | null;
          image_url?: string;
        };
        if (typeof body.url !== 'string' || !isValidUrl(body.url)) {
          return json(
            res,
            422,
            errorBody('HRC-CORE-0002', 'The submitted data is not valid.', {
              fields: { url: ['Enter a valid URL.'] },
            }),
          );
        }
        const key = normalizeUrl(body.url);
        const existing = entries.get(key);
        const applied = applyFields(existing?.fields ?? {}, body.fields ?? {});
        if ('status' in applied) return json(res, applied.status, applied.body);

        const imageUrl = typeof body.image_url === 'string' ? body.image_url : '';
        if (imageUrl.length > 0 && isUnfetchable(imageUrl)) {
          // The fetch happens inside save_entry's transaction, so an
          // address the server will not go to fails the whole call — and
          // nothing is written. Nothing is written here either: that is
          // the half of the behaviour a client has to survive.
          return json(
            res,
            422,
            errorBody('HRC-IMAGE-0006', 'That image could not be fetched.', {
              host: new URL(imageUrl).hostname,
            }),
          );
        }

        const now = timestamp();
        // One id for both the entry and its image URL. Reading
        // `nextId` twice would read it before and after the increment.
        const id = existing?.id ?? nextId++;
        const entry: EntryOut = {
          id,
          url: key,
          title: body.title ?? '',
          notes: body.notes ?? '',
          tags: [...(body.tags ?? [])].sort(),
          fields: applied.fields,
          // Like fields, and unlike every other attribute, an absent
          // image_url changes nothing — a client that predates pictures
          // cannot strip one by saving an entry.
          image:
            imageUrl.length > 0
              ? { url: `/entries/${id}/image/`, width: 1200, height: 630 }
              : (existing?.image ?? null),
          created_at: existing?.created_at ?? now,
          updated_at: now,
        };
        entries.set(key, entry);
        return json(res, existing === undefined ? 201 : 200, entry);
      }

      // The serving view an entry's `image.url` points at. It sits outside
      // /api/ and, like everything past checkAuth, answers only to a
      // request carrying the token — which is why a plain <img src> is no
      // way to show it.
      const servingRoute = /^\/entries\/(\d+)\/image\/$/.exec(requestUrl.pathname);
      if (servingRoute !== null && req.method === 'GET') {
        const id = Number(servingRoute[1]);
        const holder = [...entries.values()].find(
          (candidate) => candidate.id === id && candidate.image !== null,
        );
        if (holder === undefined) {
          return json(
            res,
            404,
            errorBody('HRC-CORE-0003', 'The requested resource does not exist.'),
          );
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': PIXEL_PNG.length,
        });
        return res.end(PIXEL_PNG);
      }

      const imageRoute = /^\/api\/entries\/(\d+)\/image$/.exec(requestUrl.pathname);
      if (imageRoute !== null) {
        const id = Number(imageRoute[1]);
        const holder = [...entries.values()].find((candidate) => candidate.id === id);
        // 404 when the entry is not yours — never 403, which would tell
        // you it exists.
        if (holder === undefined) {
          return json(
            res,
            404,
            errorBody('HRC-CORE-0003', 'The requested resource does not exist.'),
          );
        }
        if (req.method === 'POST') {
          const updated: EntryOut = {
            ...holder,
            image: { url: `/entries/${id}/image/`, width: 1200, height: 630 },
            updated_at: timestamp(),
          };
          entries.set(updated.url, updated);
          return json(res, 200, updated);
        }
        if (req.method === 'DELETE') {
          if (holder.image === null) {
            return json(
              res,
              404,
              errorBody('HRC-CORE-0003', 'The requested resource does not exist.'),
            );
          }
          entries.set(holder.url, { ...holder, image: null, updated_at: timestamp() });
          return res.writeHead(204).end();
        }
      }

      return json(
        res,
        404,
        errorBody('HRC-CORE-0003', 'The requested resource does not exist.'),
      );
    })().catch(() => {
      json(res, 500, errorBody('HRC-CORE-0001', 'Something went wrong.'));
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    reset() {
      entries = new Map();
      nextId = 1;
      outage = false;
      nextTokenId = 1;
    },
    close() {
      return new Promise((resolve, reject) => {
        // A browser leaves keep-alive sockets open, and `close()` alone
        // waits for every one of them — which is forever. Drop them first.
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
