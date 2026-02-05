import type { NextFunction, Request, Response } from 'express';
import ipaddr from 'ipaddr.js';

export type DocsConfig = {
    enabled: boolean;
    docsPath: string;
    specPath: string;
    ipAllowlist: string;
    basicUser: string;
    basicPass: string;
    servers: DocsServer[];
};

export type DocsServer = {
    url: string;
    description?: string;
};

export const normalizePath = (path: string) =>
    path.startsWith('/') ? path : `/${path}`;

const parseServers = (raw: string): DocsServer[] =>
    raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry): DocsServer | null => {
            const [url, description] = entry
                .split('|')
                .map((part) => part.trim())
                .filter(Boolean);
            if (!url) {
                return null;
            }
            return description ? { url, description } : { url };
        })
        .filter((entry): entry is DocsServer => entry !== null);

export const buildDocsConfig = (env: NodeJS.ProcessEnv): DocsConfig => ({
    enabled: env.API_DOCS_ENABLED === 'true',
    docsPath: normalizePath(env.API_DOCS_PATH || '/docs'),
    specPath: normalizePath(env.API_DOCS_SPEC_PATH || '/openapi.json'),
    ipAllowlist: env.API_DOCS_IP_ALLOWLIST || '',
    basicUser: env.API_DOCS_BASIC_USER || '',
    basicPass: env.API_DOCS_BASIC_PASS || '',
    servers: parseServers(env.API_DOCS_SERVER_URLS || ''),
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
            const allowed = allowlist.some(([net, prefix]) =>
                addr.match(net, prefix),
            );
            if (!allowed) {
                return res.status(403).end();
            }
            return next();
        } catch {
            return res.status(403).end();
        }
    };
};

export const createDocsBasicAuthMiddleware =
    (user: string, pass: string) =>
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
