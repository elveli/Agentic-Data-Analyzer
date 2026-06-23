# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run dev           # tsx server.ts — runs Express + Vite middleware dev server on http://localhost:3000
npm run build         # vite build (client) + esbuild bundle of server.ts -> dist/server.cjs
npm run start         # node dist/server.cjs — run the production build
npm run lint          # tsc --noEmit (type-check only, no test runner configured)
npm run clean         # rm -rf dist server.js
```

There is no test suite in this repo — `npm run lint` (type checking) is the only automated check.

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

- **`server.ts`**: Express app. In dev, mounts Vite as middleware (`createViteServer({ middlewareMode: true })`); in production serves `dist/` as static files with a catch-all SPA route. The core endpoint is `POST /api/analyze`, which lazily instantiates a `GoogleGenAI` client (`@google/genai`), builds a system instruction describing the agentic pipeline steps (`pipelineSteps` from the request body), and calls Gemini with `responseMimeType: 'application/json'` to force structured output (`logs`, `insights`, `chartData`, `chartType`, `chartKeys`, `markdownReport`). `GET /api/pipelines` / `POST /api/pipelines` manage an in-memory (non-persisted) list of saved pipeline configs.
- **`src/App.tsx`**: Single-page React UI (no router) with three tabs (`pipeline`, `infra`, `workspace`) toggled by local state. The "pipeline" tab lets the user pick a data template, set an analysis goal, toggle pipeline steps, and POST to `/api/analyze`; results render as Recharts (bar/line) plus markdown insights. If the fetch fails (e.g. missing `GEMINI_API_KEY`), it falls back to a client-side mock/sandbox response generated from a naive CSV parse of the input, so the UI stays interactive without a working backend. The "infra" tab is a read-only code viewer embedding string copies of the Terraform files, `deploy.yml`, and a server.ts snippet (sourced from `src/data.ts`) purely for display/copy — these are NOT the live source of truth, they are illustrative copies and can drift from the real files.
- **`src/data.ts`**: Static template data (sample datasets/goals) and the display-only string copies of `.tf` files / pipeline code shown in the "infra" tab.
- **Database**: Amazon RDS PostgreSQL with the `pgvector` extension serves as both the relational store and the vector DB (collapsing what would otherwise be two separate services to cut cost). Locally, `docker-compose.yml` runs `pgvector/pgvector:pg15` for the same role. Note the app currently does not contain actual DB client/query code in `server.ts` — vector sync/storage referenced in the UI and prompts is currently simulated rather than wired to a real DB client.
- **`terraform/`**: Provisions one VPC with two public subnets, an ALB, an ECS Fargate service/task (port 3000) behind it, an ECR repo for the app image, an RDS Postgres instance (`db.t4g.micro`), and Secrets Manager entries for the DB password and Gemini API key. The ECS task definition injects `NODE_ENV`/`DB_HOST`/`DB_USER`/`DB_NAME` as plain `environment` values, but `DB_PASS` and `GEMINI_API_KEY` go through the task definition's `secrets` field (ARN references to `aws_secretsmanager_secret.db_password`/`gemini_key`), resolved by the ECS execution role at container startup via `aws_iam_role_policy.ecs_secrets_access` — they are never embedded as plaintext in the task definition or shown in the ECS console. The RDS instance is **not** publicly accessible — its security group (`db_sg`) only allows port 5432 from the ECS tasks' security group, not `0.0.0.0/0`. `providers.tf` applies `default_tags` (`Project`/`Environment`/`ManagedBy`) to every resource via the AWS provider, so individual resources only need a `Name` tag where one adds value beyond their own `name`/`identifier` attribute.
- **`terraform/bootstrap/`**: Separate one-time-use config (own local state) that creates the S3 bucket + DynamoDB table used as the main config's remote backend. It can't itself use that backend (chicken-and-egg), so don't try to point it at `backend.hcl`.
- **`.github/workflows/deploy.yml`**: On push to `main`, builds the app, pushes the Docker image to ECR, then runs `terraform init` (with `-backend-config` flags built from the `TF_STATE_BUCKET`/`TF_STATE_LOCK_TABLE` secrets) and `plan`/`apply` from `terraform/` using `TF_VAR_aws_region` and `TF_VAR_gemini_api_key`. This always re-applies against the same remote state — there's no per-branch/per-PR environment isolation. Keep it consistent with any Terraform variable or backend changes.
- **Env vars**: `GEMINI_API_KEY` is required for real Gemini calls (`.env`, copied from `.env.example`). The Gemini model used is hardcoded in `server.ts` as `gemini-3.5-flash`.
