# Lorelum site (TanStack Start + Fumadocs)

Landing + Docs site built with [TanStack Start](https://tanstack.com/start) and
[Fumadocs](https://fumadocs.dev). Part of the P0 website spike
([#1](https://github.com/AzMilabo/lorelum/issues/1)).

## Development

```bash
bun install
bun run --filter @lorelum/site dev        # http://localhost:3000
bun run --filter @lorelum/site typecheck  # tsc --noEmit
bun run --filter @lorelum/site build      # static + Cloudflare Worker output in dist/
```

## Routes

- `/` — landing (default English), with a client-hydrated terminal demo
- `/en` / `/zh` — per-locale landing
- `/en/docs` / `/zh/docs` — bilingual docs (en: `content/docs/*.mdx`, zh: `*.zh.mdx`)
- `/llms.txt`, `/llms-full.txt` — LLM-friendly content export
- `/api/search` — built-in ZBSearch endpoint

Content is wired to Fumadocs via `src/lib/source.ts`; i18n config lives in
`src/lib/i18n.ts`.

## Deployment

The site is deployed to **Cloudflare Workers** (project `lorelum`) with
Git-integrated **Workers Builds** plus manual `wrangler deploy` direct
uploads. `wrangler.jsonc` points `main` at
`@tanstack/react-start/server-entry`.

Local verification:

```bash
bun run --filter @lorelum/site build
cd apps/site && npx wrangler dev --port 8788
```

Deploy:

```bash
bun run build:site && bun run deploy:site   # manual direct upload, no build quota
git push origin main                        # or: GitHub Actions auto-deploy (path-filtered)
```

See `docs/development/site-deploy.md` for the full deployment workflow (path
filtering, secrets, release), and `docs/research/tanstack-fumadocs-spike.md` for
the spike conclusion and risks.
