# OpenAPI + Swagger UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add OpenAPI JSON and Swagger UI endpoints to the API in Staging/QA, protected by Basic Auth and IP allowlist, behind a feature flag.

**Architecture:** Introduce a small docs guard module for IP allowlist and Basic Auth middleware, plus a config helper to read env vars. Wire SwaggerModule in `apps/api/src/main.ts` only when enabled.

**Tech Stack:** NestJS, Express middleware, Jest, @nestjs/swagger, swagger-ui-express, ipaddr.js.

### Task 1: Docs Guard Tests (RED)

**Files:**
- Create: `test/unit/api/docs/docs-guard.spec.ts`

**Step 1: Write the failing test**

```ts
import type { Request, Response, NextFunction } from 'express';
import {
  buildDocsConfig,
  createDocsIpAllowlistMiddleware,
  createDocsBasicAuthMiddleware,
  normalizePath,
} from '../../../../apps/api/src/docs/docs-guard';

describe('docs guard', () => {
  describe('normalizePath', () => {
    it('adds leading slash when missing', () => {
      expect(normalizePath('docs')).toBe('/docs');
    });

    it('keeps leading slash', () => {
      expect(normalizePath('/docs')).toBe('/docs');
    });
  });

  describe('buildDocsConfig', () => {
    it('uses defaults when env vars are missing', () => {
      const cfg = buildDocsConfig({} as NodeJS.ProcessEnv);
      expect(cfg.enabled).toBe(false);
      expect(cfg.docsPath).toBe('/docs');
      expect(cfg.specPath).toBe('/openapi.json');
    });

    it('reads env vars', () => {
      const cfg = buildDocsConfig({
        API_DOCS_ENABLED: 'true',
        DOCS_PATH: '/api-docs',
        DOCS_SPEC_PATH: '/spec.json',
      } as NodeJS.ProcessEnv);
      expect(cfg.enabled).toBe(true);
      expect(cfg.docsPath).toBe('/api-docs');
      expect(cfg.specPath).toBe('/spec.json');
    });
  });

  describe('IP allowlist', () => {
    const makeReq = (ip: string, xfwd?: string) =>
      ({
        ip,
        headers: xfwd ? { 'x-forwarded-for': xfwd } : {},
      }) as unknown as Request;

    const makeRes = () => {
      const res = {
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        end: jest.fn(),
      } as unknown as Response;
      return res;
    };

    it('blocks when allowlist is empty', () => {
      const mw = createDocsIpAllowlistMiddleware('');
      const res = makeRes();
      mw(makeReq('103.72.59.10'), res, jest.fn() as NextFunction);
      expect(res.statusCode).toBe(403);
    });

    it('allows IP inside CIDR', () => {
      const mw = createDocsIpAllowlistMiddleware('103.72.59.0/24');
      const next = jest.fn();
      const res = makeRes();
      mw(makeReq('103.72.59.10'), res, next as NextFunction);
      expect(next).toHaveBeenCalled();
    });

    it('blocks IP outside CIDR', () => {
      const mw = createDocsIpAllowlistMiddleware('103.72.59.0/24');
      const res = makeRes();
      mw(makeReq('1.2.3.4'), res, jest.fn() as NextFunction);
      expect(res.statusCode).toBe(403);
    });

    it('uses first X-Forwarded-For when present', () => {
      const mw = createDocsIpAllowlistMiddleware('103.72.59.0/24');
      const next = jest.fn();
      const res = makeRes();
      mw(makeReq('1.2.3.4', '103.72.59.10, 10.0.0.1'), res, next as NextFunction);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('Basic Auth', () => {
    const makeReq = (auth?: string) =>
      ({
        headers: auth ? { authorization: auth } : {},
      }) as unknown as Request;

    const makeRes = () => {
      const res = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        setHeader(key: string, value: string) {
          this.headers[key] = value;
        },
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        end: jest.fn(),
      } as unknown as Response;
      return res;
    };

    it('returns 401 without auth header', () => {
      const mw = createDocsBasicAuthMiddleware('user', 'pass');
      const res = makeRes();
      mw(makeReq(), res, jest.fn() as NextFunction);
      expect(res.statusCode).toBe(401);
      expect(res.headers['WWW-Authenticate']).toBe('Basic');
    });

    it('returns 401 for invalid credentials', () => {
      const mw = createDocsBasicAuthMiddleware('user', 'pass');
      const res = makeRes();
      const bad = Buffer.from('user:wrong', 'utf8').toString('base64');
      mw(makeReq(`Basic ${bad}`), res, jest.fn() as NextFunction);
      expect(res.statusCode).toBe(401);
    });

    it('allows valid credentials', () => {
      const mw = createDocsBasicAuthMiddleware('user', 'pass');
      const res = makeRes();
      const next = jest.fn();
      const ok = Buffer.from('user:pass', 'utf8').toString('base64');
      mw(makeReq(`Basic ${ok}`), res, next as NextFunction);
      expect(next).toHaveBeenCalled();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `yarn test test/unit/api/docs/docs-guard.spec.ts`
Expected: FAIL (module not found for `docs-guard`).

### Task 2: Docs Guard Implementation (GREEN)

**Files:**
- Create: `apps/api/src/docs/docs-guard.ts`

**Step 1: Write minimal implementation**

```ts
import type { NextFunction, Request, Response } from 'express';
import ipaddr from 'ipaddr.js';

export type DocsConfig = {
  enabled: boolean;
  docsPath: string;
  specPath: string;
  ipAllowlist: string;
  basicUser: string;
  basicPass: string;
};

export const normalizePath = (path: string) =>
  path.startsWith('/') ? path : `/${path}`;

export const buildDocsConfig = (env: NodeJS.ProcessEnv): DocsConfig => ({
  enabled: env.API_DOCS_ENABLED === 'true',
  docsPath: normalizePath(env.DOCS_PATH || '/docs'),
  specPath: normalizePath(env.DOCS_SPEC_PATH || '/openapi.json'),
  ipAllowlist: env.DOCS_IP_ALLOWLIST || '',
  basicUser: env.DOCS_BASIC_USER || '',
  basicPass: env.DOCS_BASIC_PASS || '',
});

const parseAllowlist = (raw: string) =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ipaddr.parseCIDR(entry));

const getClientIp = (req: Request) => {
  const xfwd = (req.headers['x-forwarded-for'] as string) || '';
  const candidate = xfwd.split(',')[0]?.trim() || req.ip || '';
  return candidate.replace('::ffff:', '');
};

export const createDocsIpAllowlistMiddleware = (allowlistRaw: string) => {
  const allowlist = parseAllowlist(allowlistRaw);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!allowlist.length) {
      return res.status(403).end();
    }
    try {
      const ip = getClientIp(req);
      const addr = ipaddr.parse(ip);
      const allowed = allowlist.some(([net, prefix]) => addr.match(net, prefix));
      if (!allowed) {
        return res.status(403).end();
      }
      return next();
    } catch {
      return res.status(403).end();
    }
  };
};

export const createDocsBasicAuthMiddleware = (user: string, pass: string) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!user || !pass) {
      res.setHeader('WWW-Authenticate', 'Basic');
      return res.status(401).end();
    }
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic');
      return res.status(401).end();
    }
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const [u, p] = decoded.split(':');
    if (u !== user || p !== pass) {
      res.setHeader('WWW-Authenticate', 'Basic');
      return res.status(401).end();
    }
    return next();
  };
```

**Step 2: Run test to verify it passes**

Run: `yarn test test/unit/api/docs/docs-guard.spec.ts`
Expected: PASS.

### Task 3: Swagger/OpenAPI Wiring (RED/GREEN)

**Files:**
- Modify: `apps/api/src/main.ts`
- Modify: `package.json`
- Modify: `yarn.lock`

**Step 1: Write failing test**

(If adding integration tests is too heavy, skip and proceed with manual verification.)

**Step 2: Implement minimal wiring**

- Add imports from `@nestjs/swagger` and `./docs/docs-guard`.
- Build docs config from env.
- If enabled, attach `createDocsIpAllowlistMiddleware` and `createDocsBasicAuthMiddleware` for `/docs` and `/openapi.json`.
- Create Swagger document with `DocumentBuilder` and set up Swagger UI.
- Expose JSON spec at `/openapi.json` using Express instance (`app.getHttpAdapter().getInstance()`).
- Disable “Try it out” by setting `swaggerOptions.supportedSubmitMethods = []`.

**Step 3: Add dependencies**

Add packages:
- `@nestjs/swagger`
- `swagger-ui-express`
- `ipaddr.js`

Command: `yarn add @nestjs/swagger swagger-ui-express ipaddr.js`
Expected: `yarn.lock` updated.

**Step 4: Verification**

Run: `yarn test test/unit/api/docs/docs-guard.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/main.ts apps/api/src/docs/docs-guard.ts test/unit/api/docs/docs-guard.spec.ts package.json yarn.lock
git commit -m "feat: add swagger/openapi docs with guards"
```

## Notes
- If `yarn install` or `yarn add` fails due to network restrictions, proceed with code changes and let the user run dependency installation locally.
