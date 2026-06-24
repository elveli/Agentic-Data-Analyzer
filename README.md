# Agentic Data Analyzer - Low-Cost serverless LLM Data Processing Pipeline

This project provides an **AI Agentic Framework** that automates complex data analysis tasks (ingestion, sanitization, Vector search sync, trend discovery, forecasting, and narrative synthesis) using Google Gemini and serverless infrastructure.

## 🛠️ System Architecture

The infrastructure is optimized to provide high durability, extreme scalability, and **lowest possible cost** (under $15/month for low-usage development environments):

1. **Compute (AWS ECS Fargate)**: Implements the Node.js/Express API and React client in a single container. The ECS service has Application Auto Scaling wired to it (`aws_appautoscaling_target`/`aws_appautoscaling_policy` in `terraform/main.tf`) on a CPU target-tracking policy (60% target, 1-3 tasks), so sustained load actually adds tasks instead of always landing on the same one.
2. **Database (Amazon RDS PostgreSQL + PGVECTOR)**: Serves as both your relational configuration store and your **Scalable Vector Database** using Postgres' native `pgvector` extension. The app genuinely writes to it: each analysis run embeds the parsed dataset and stores the vectors in the `document_embeddings` table (see "Pipeline Architecture" below). Using a single database for both roles saves hundreds of dollars compared to independent vector products (Pinecone, Weaviate setups). Setting the instance class to a small burstable `db.t4g.micro` keeps the database running for around **$11.50/month**.
3. **LLM Engine (Google Gemini)**: `server.ts` calls Gemini server-side via the `@google/genai` npm package (just a normal dependency in `package.json`, installed like any other during `npm ci` in the Docker build). Gemini itself is an external Google Cloud API, not an AWS resource Terraform deploys. The API key is stored in AWS Secrets Manager and the ECS task definition's `secrets` field pulls it from there at container startup — it's resolved into `GEMINI_API_KEY` at runtime, not embedded as plaintext in the task definition.

### Pipeline Architecture

Each "Execute Analysis Process" run is a real sequential pipeline, not one LLM call pretending to be one. `POST /api/analyze` streams progress to the browser over Server-Sent Events as each stage actually finishes:

1. **Parsing** - deterministic, no model call. The raw CSV/text is parsed into structured rows in Node.
2. **Vector store** - the parsed rows are embedded with Gemini's `gemini-embedding-001` model (768 dimensions) and written into the `document_embeddings` table via a real `pg` connection. If the database isn't reachable, this step reports a real error and the pipeline continues with the other steps.
3. **Anomaly detector** - a Gemini `generateContent` call given only the parsed rows and your goal, asked to return structured insights (anomalies/trends/forecasts) as JSON.
4. **Reporter** - a final Gemini call that synthesizes the chart data and markdown report from the dataset, the insights step 3 actually found, and the real vector-store stats - not fabricated from scratch.

This means a full run costs **3 Gemini API calls** (1 embedding + 2 `generateContent`), each taking anywhere from a few seconds to ~60s depending on model load. On the free tier (20 `generateContent` requests/day at time of writing), that's roughly 10 full runs/day - plan accordingly if you're demoing this to a group, and expect occasional transient `503 UNAVAILABLE` errors under high model demand (the pipeline retries those automatically with backoff, but a `429 RESOURCE_EXHAUSTED` means the daily quota is actually spent and won't recover until it resets).

### System Diagram

```mermaid
graph TD
    User([User / Browser]) -->|HTTPS| ECSFargate[AWS ECS Fargate]
    
    subgraph "AWS Ecosystem"
      ECSFargate -.->|Reads Secrets| SecretsManager[AWS Secrets Manager]
      ECSFargate <-->|Reads/Writes Vectors| RDS[(Amazon RDS PostgreSQL\n+ pgvector)]
    end
    
    ECSFargate <-->|API Calls| Gemini[Google Gemini API]
    
    subgraph "CI/CD Pipeline (GitHub Actions)"
      GitHub[GitHub Repository] -->|1. Build & Push Image| ECR[Amazon ECR]
      GitHub -->|2. Apply Terraform| AWS_Infra[AWS Infrastructure]
      ECR -->|Deploy| ECSFargate
    end
```

---

## 🎮 How to Use the Application

Once running locally or deployed, open the application in your browser to interact with the Agentic Data Processing Pipeline:

1. **Workspace Explorer**: The default view shows the repository files. Read the `README.md`, examine the `deploy.yml`, or look at the CI/CD code snippets.
2. **Analysis Pipeline (Action Center)**: Click the "Analysis Pipeline" tab to view the live processing interface.
3. **Select a Data Template**: Choose either "SaaS Subscription Metrics" or "E-Commerce User Retention Data" as sample data to process.
4. **Execute Pipeline**: Click **Execute Agentic Pipeline**. The terminal panel updates live as each real step finishes (parsing, then vector embedding/storage, then anomaly detection, then report synthesis) - see "Pipeline Architecture" above for exactly what each step does.
5. **View Results**: Once the reporter step completes, the insights, chart, and markdown report populate from what the pipeline actually found - not a pre-canned response.

---

## 📊 Monitoring AWS Once Deployed

Once you have deployed the application to AWS using Terraform or GitHub Actions, you can monitor the application and track its behavior natively inside the AWS Management Console:

### 1. AWS ECS Console (Compute & Logs)
- Navigate to **Elastic Container Service** in the AWS Console.
- Select your cluster (`agentic-data-analyzer-cluster`).
- **Logs**: Click the **Logs** tab on your task or service to see real-time output from your Node.js Express server. This is where you will see the vector embeddings syncing and Gemini API calls occurring.
- **Metrics**: View the CPU usage, memory utilization, and active request count under the **Metrics** tab.
- **Watching it scale**: The service's desired task count is managed by Application Auto Scaling (target: 60% average CPU, 1-3 tasks). To actually see it scale out, generate sustained concurrent load against the ALB's DNS name (from `terraform output app_url`), e.g. with [`hey`](https://github.com/rakyll/hey): `hey -z 5m -c 10 -m POST -H "Content-Type: application/json" -d '{"data":"...","goal":"...","pipelineSteps":["parsing"]}' http://YOUR_ALB_DNS/api/analyze` (use only the `parsing` step for load-testing, since it's the only one that doesn't call Gemini and won't burn your API quota). Watch the **Tasks** count on the service's **Service auto scaling** tab rise as CPU climbs.

### 2. Amazon RDS (Database Insights & PGVECTOR)
- **PGVECTOR Purpose**: The database uses the `pgvector` extension to store semantic embeddings (high-dimensional arrays) generated by the AI models. This allows the agent to perform similarity searches (e.g., finding past documents that mean the same thing, rather than just exact keyword matches).
- **View Dashboard**: Navigate to **RDS** -> **Databases** in the AWS Console. Select the `agentic-data-analyzer-postgres` instance to see active connections and CPU loads.
- **Login to Database Endpoint**: The database is **not** publicly accessible — its security group only allows Postgres traffic from the ECS tasks' security group, so you can't `psql` into it directly from your laptop. To inspect data manually:
  1. Retrieve the auto-generated database password from **AWS Secrets Manager** (`agentic-data-analyzer-db-password`).
  2. Get the database endpoint from the RDS Console (e.g., `agentic-data-analyzer-postgres.xxxxxx.region.rds.amazonaws.com`).
  3. Connect from somewhere inside the VPC. The simplest option for occasional debugging is to temporarily add your current IP to the `db_sg` security group's ingress rules (via the console, or a scoped `terraform apply`), connect with `psql -h YOUR_DB_ENDPOINT -U agent_admin -d agentic_workspace`, then remove the rule when you're done. For routine access without opening the database to the internet, run a small bastion host or use AWS Systems Manager (SSM) port forwarding from an instance inside the same VPC instead.
  4. Once connected, you can run queries on the `document_embeddings` table to inspect the exact high-dimensional vectors stored by the LLM.

### 3. AWS CloudWatch (Alarms & Dashboards)
- All the ECS Fargate logs and RDS metrics are automatically forwarded to **CloudWatch**.
- Navigate to **CloudWatch** -> **Log groups** to query historical logs or set up error alerting.

### 4. AWS CLI (Debugging & Logs)
For developers preferring the terminal, you can stream logs and check service status using the AWS CLI:

**View ECS Service Status:**
```bash
aws ecs describe-services --cluster agentic-data-analyzer-cluster --services agentic-data-analyzer-service --region YOUR_AWS_REGION
```

**List Running Tasks:**
```bash
aws ecs list-tasks --cluster agentic-data-analyzer-cluster --region YOUR_AWS_REGION
```
Useful for confirming how many tasks are currently up (e.g. while watching Application Auto Scaling react to load - see "Watching it scale" above). Feed a task ARN from the output into `describe-tasks` for its health/IP/last status:
```bash
aws ecs describe-tasks --cluster agentic-data-analyzer-cluster --tasks TASK_ARN --region YOUR_AWS_REGION
```

**Tail ECS Application Logs:**
```bash
aws logs tail /ecs/agentic-data-analyzer --follow
```

**Check Database Status:**
```bash
aws rds describe-db-instances \
    --db-instance-identifier agentic-data-analyzer-postgres \
    --query 'DBInstances[*].[DBInstanceStatus, Endpoint.Address]'
```

---

## 📁 Directory Structure

- `/server.ts`: The Express server powering the agentic pipeline - real parsing, embedding/pgvector storage (via `pg`), anomaly detection, and report synthesis as four genuinely sequential, server-sent-event-streamed steps (see "Pipeline Architecture" above).
- `/src/`: React visual companion companion console, containing interactive charts, drag-and-drop file ingestion, pipeline editor, and config explorers.
- `/terraform/`: Infrastructure-as-code files:
  - `main.tf`: Declares VPC networks, firewall parameters, serverless access connectors, postgres vector databases, and container host policies.
  - `providers.tf`, `variables.tf`, `outputs.tf`: Full terraform config structures.
  - `backend.hcl.example`: Template for the values `terraform init -backend-config=...` needs to use the remote (S3 + DynamoDB) state backend.
  - `bootstrap/`: One-time-use Terraform config that creates the S3 state bucket and DynamoDB lock table referenced above. Run it once per AWS account, with its own local state (it can't depend on the backend it creates).
- `/.github/workflows/deploy.yml`: Production CI/CD workflow pushing code to Amazon ECR and executing `terraform apply` seamlessly on commit.

---

## 🚀 Local Quickstart

### 1. Configure Secrets
Ensure you have your Gemini API secret key. The Google Gemini API powers the AI capabilities of this application, such as analyzing data chunks, generating insights, and synthesizing narratives. You can get a free API key from [Google AI Studio](https://aistudio.google.com). 

From the root directory of the project (where this README is located), copy `.env.example` to `.env` :
```bash
cp .env.example .env
```
Specify your `GEMINI_API_KEY` inside `.env`. The `DB_*` values in `.env.example` already match `docker-compose.yml`'s Postgres service - leave them as-is for local development.

### 2. Live Dev Server
The vector-store pipeline step needs a real Postgres/pgvector instance, so start just that container first:
```bash
docker-compose up -d postgres
```
Then run the app (port 3000):
```bash
npm install
npm run dev
```
Open your browser at `http://localhost:3000`. (If you skip the `docker-compose up -d postgres` step, the app still runs - the vector-store step will just report a real connection error and the rest of the pipeline continues.)

### 3. Run Locally with Docker Desktop
If you prefer to run the entire stack (Node.js App + PostgreSQL pgvector Database) locally using Docker:

1. Ensure **Docker Desktop** is installed and running.
2. Build and start the containers using Docker Compose:
```bash
docker-compose up --build
```
3. Open your browser at `http://localhost:3000`. The application will connect to the local Dockerized PostgreSQL instance automatically.

---

## ☁️ Cloud Provisioning via Terraform

Terraform state is stored remotely (S3 + DynamoDB locking) rather than on disk, so it stays consistent across your machine and CI. That backend has to exist before the main config can use it — do this **once per AWS account**:

```bash
cd terraform/bootstrap

terraform init

# Choose a globally-unique bucket name, e.g. agentic-data-analyzer-tfstate-<your-account-id>
terraform apply -var="state_bucket_name=YOUR_UNIQUE_BUCKET_NAME"
```

Then create your local backend config from the example and point the main config at it:

```bash
cd ../   # back in terraform/
cp backend.hcl.example backend.hcl
# edit backend.hcl with the bucket/table names from the bootstrap step above
```

Now spin up the rest of the low-cost ecosystem:

```bash
# Initialize terraform plugins and the remote backend
terraform init -backend-config=backend.hcl

# Review the planned list of resources
terraform plan \
  -var="aws_region=YOUR_AWS_REGION" \
  -var="gemini_api_key=YOUR_GEMINI_KEY"

# Provision infrastructure on AWS
terraform apply \
  -var="aws_region=YOUR_AWS_REGION" \
  -var="gemini_api_key=YOUR_GEMINI_KEY"\
  -auto-approve
```

---

## 🔄 CI/CD Git Deployment
The workflow at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds the app, pushes the Docker image to Amazon ECR, and runs `terraform apply` automatically on every push to `main`. The database password is not a secret you provide — Terraform generates and stores it for you in AWS Secrets Manager.

To enable this for your own fork/repo:

1. Push this repository to your own GitHub account (if you haven't already).
2. Run the bootstrap step described under "Cloud Provisioning via Terraform" above once so the state bucket/lock table exist.
3. In your repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `AWS_ACCESS_KEY_ID`: Access key ID for an AWS IAM user/role with permission to manage the resources in `terraform/` (VPC, ECS, RDS, ECR, IAM, Secrets Manager, S3, DynamoDB).
   - `AWS_SECRET_ACCESS_KEY`: The matching AWS secret access key.
   - `AWS_DEFAULT_REGION`: The AWS region to deploy into (e.g. `us-east-1`).
   - `GEMINI_API_KEY`: Your Gemini API key, stored in AWS Secrets Manager and injected into the ECS task at deploy time.
   - `TF_STATE_BUCKET`: The S3 bucket name created by the bootstrap step.
   - `TF_STATE_LOCK_TABLE`: The DynamoDB table name created by the bootstrap step (defaults to `agentic-data-analyzer-tf-locks`).
4. Push to the `main` branch (or merge a PR into it) to trigger the workflow under the **Actions** tab.

> Note: this CI/CD flow always re-runs `terraform apply` against the same state, so it's meant for a single long-lived environment rather than per-branch/per-PR deployments.
