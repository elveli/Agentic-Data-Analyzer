# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
docker-compose up -d postgres   # start pgvector locally - required by the vector-store pipeline step
npm install          # install dependencies
npm run dev           # tsx server.ts — runs Express + Vite middleware dev server on http://localhost:3000
npm run build         # vite build (client) + esbuild bundle of server.ts -> dist/server.cjs
npm run start         # node dist/server.cjs — run the production build
npm run lint          # tsc --noEmit (type-check only, no test runner configured)
npm run clean         # rm -rf dist server.js
```

There is no test suite in this repo — `npm run lint` (type checking) is the only automated check. `npm run lint` currently reports two pre-existing errors in `src/ErrorBoundary.tsx` (`setState`/`props` not found on the class) unrelated to any of the pipeline/infra work above; they predate it.

Local full-stack run with Postgres/pgvector via Docker:
```bash
docker-compose up --build   # app on :3000, postgres/pgvector on :5432
```

Terraform (run from `terraform/`). State is remote (S3 + DynamoDB lock), so `terraform/bootstrap/` must be applied once per AWS account first to create the backend bucket/table, and `terraform/backend.hcl.example` copied to `backend.hcl` with those names before `init`:
```bash
cd terraform/bootstrap && terraform init && terraform apply -var="state_bucket_name=YOUR_UNIQUE_BUCKET_NAME"  # once per account
cd ../ && cp backend.hcl.example backend.hcl   # fill in bucket/table names from above
terraform init -backend-config=backend.hcl
terraform plan  -var="aws_region=YOUR_AWS_REGION" -var="gemini_api_key=YOUR_GEMINI_KEY"
terraform apply -var="aws_region=YOUR_AWS_REGION" -var="gemini_api_key=YOUR_GEMINI_KEY" -auto-approve
```

## Architecture

This is a single-container full-stack app: one Express server (`server.ts`) serves both the API and, in dev, the Vite middleware for the React client (`src/`); in production it serves the static `dist/` build instead.

- **`server.ts`**: Express app. In dev, mounts Vite as middleware (`createViteServer({ middlewareMode: true })`); in production serves `dist/` as static files with a catch-all SPA route. The core endpoint is `POST /api/analyze`, which runs four genuinely sequential pipeline steps and streams a Server-Sent Event after each one finishes (`{ stepId, status, message }`, terminated by `{ done: true, result }` or `{ done: true, error }`):
  1. `parseRows` — deterministic CSV/freeform parsing, no model call.
  2. `embedAndStore` — embeds parsed rows with `ai.models.embedContent` (model `gemini-embedding-001`, 768 dims) and writes them into Postgres via a lazy `pg.Pool` (`getDbPool`), into a `document_embeddings` table created on first use by `ensureSchema` (`CREATE EXTENSION IF NOT EXISTS vector` + `CREATE TABLE ... VECTOR(768)` + an HNSW index). DB errors here are caught and reported as a step-level error without aborting the rest of the pipeline.
  3. `detectAnomalies` — a `generateContent` call scoped to just the parsed rows + goal, returns structured insights JSON.
  4. `buildReport` — a final `generateContent` call that synthesizes chart data + markdown from the dataset, step 3's actual insights, and the real vector-store stats.
  Both `generateContent` calls (and the embed call) go through `withRetry`, which retries transient `503 UNAVAILABLE` errors with backoff — but not `429 RESOURCE_EXHAUSTED` (daily quota exhaustion), which fails immediately since retrying won't help. `GET /api/pipelines` / `POST /api/pipelines` still manage an in-memory (non-persisted) list of saved pipeline configs, unrelated to `/api/analyze`.
- **`src/App.tsx`**: Single-page React UI (no router) with three tabs (`pipeline`, `infra`, `workspace`) toggled by local state. The "pipeline" tab's `runAnalysisPipeline` POSTs to `/api/analyze` and reads the response body as a stream, splitting on `\n\n` and parsing each `data: {...}` SSE event — `pushLog` reflects each step's *real* status as it arrives, and the terminal `done` event populates `analysisResult`. There is no more client-side mock fallback: if the request fails before/during streaming, `errorMessage` shows the real error instead of silently faking a result. The "infra" tab is a read-only code viewer embedding string copies of the Terraform files, `deploy.yml`, and a server.ts snippet (sourced from `src/data.ts`) purely for display/copy — these are NOT the live source of truth and can drift from the real files.
- **`src/data.ts`**: Static template data (sample datasets/goals) and the display-only string copies of `.tf` files / pipeline code shown in the "infra" tab.
- **Database**: Amazon RDS PostgreSQL with the `pgvector` extension serves as both the relational store and the vector DB. Locally, `docker-compose.yml` runs `pgvector/pgvector:pg15` for the same role (`docker-compose up -d postgres` before `npm run dev` if not running the full stack). `server.ts` genuinely connects via `pg` and writes real embeddings — this is no longer simulated.
- **`terraform/`**: Provisions one VPC with two public subnets, an ALB, an ECS Fargate service/task (port 3000) behind it with Application Auto Scaling (`aws_appautoscaling_target`/`aws_appautoscaling_policy`, CPU target-tracking at 60%, 1-3 tasks — note `aws_ecs_service.app_service` has `lifecycle { ignore_changes = [desired_count] }` so Terraform doesn't fight the autoscaler), an ECR repo for the app image, an RDS Postgres instance (`db.t4g.micro`), and Secrets Manager entries for the DB password and Gemini API key. The ECS task definition injects `NODE_ENV`/`DB_HOST`/`DB_USER`/`DB_NAME` as plain `environment` values, but `DB_PASS` and `GEMINI_API_KEY` go through the task definition's `secrets` field (ARN references to `aws_secretsmanager_secret.db_password`/`gemini_key`), resolved by the ECS execution role at container startup via `aws_iam_role_policy.ecs_secrets_access` — they are never embedded as plaintext in the task definition or shown in the ECS console. The RDS instance is **not** publicly accessible — its security group (`db_sg`) only allows port 5432 from the ECS tasks' security group, not `0.0.0.0/0`. `providers.tf` applies `default_tags` (`Project`/`Environment`/`ManagedBy`) to every resource via the AWS provider, so individual resources only need a `Name` tag where one adds value beyond their own `name`/`identifier` attribute.
- **`terraform/bootstrap/`**: Separate one-time-use config (own local state) that creates the S3 bucket + DynamoDB table used as the main config's remote backend. It can't itself use that backend (chicken-and-egg), so don't try to point it at `backend.hcl`.
- **`.github/workflows/deploy.yml`**: On push to `main`, builds the app, pushes the Docker image to ECR, then runs `terraform init` (with `-backend-config` flags built from the `TF_STATE_BUCKET`/`TF_STATE_LOCK_TABLE` secrets) and `plan`/`apply` from `terraform/` using `TF_VAR_aws_region` and `TF_VAR_gemini_api_key`. This always re-applies against the same remote state — there's no per-branch/per-PR environment isolation. Keep it consistent with any Terraform variable or backend changes.
- **Env vars**: `GEMINI_API_KEY` is required for real Gemini calls (`.env`, copied from `.env.example`). `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASS`/`DB_NAME` are required for the vector-store step locally and default (in `.env.example`) to `docker-compose.yml`'s Postgres credentials. The `generateContent` model is hardcoded in `server.ts` as `GEMINI_MODEL = "gemini-3.5-flash"`; the embedding model as `EMBEDDING_MODEL = "gemini-embedding-001"`. Free-tier Gemini quota is small (20 `generateContent`/day at time of writing) and each full pipeline run uses 2 of those plus 1 embed call — burn through it fast when testing repeatedly.
