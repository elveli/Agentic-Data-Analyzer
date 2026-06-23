# Agentic Data Analyzer - Low-Cost serverless LLM Data Processing Pipeline

This project provides an **AI Agentic Framework** that automates complex data analysis tasks (ingestion, sanitization, Vector search sync, trend discovery, forecasting, and narrative synthesis) using Google Gemini and serverless infrastructure.

## 🛠️ System Architecture

The infrastructure is optimized to provide high durability, extreme scalability, and **lowest possible cost** (under $15/month for low-usage development environments):

1. **Compute (Cloud Run)**: Implements the Node.js/Express API and React client in a single container. Since Cloud Run scales down to 0 when idle, idle costs are strictly **$0.00**.
2. **Database (Cloud SQL PostgreSQL + PGVECTOR)**: Serves as both your relational configuration store and your **Scalable Vector Database** using Postgres' native `pgvector` extension. Using a single database for both roles saves hundreds of dollars compared to independent vector products (Pinecone, Weaviate setups). Setting the instance to `db-f1-micro` keeps the database running for around **$9.90/month**.
3. **LLM Engine (Google Gemini)**: Driven via the Node `@google/genai` TypeScript SDK server-side on Cloud Run, securing keys via GCP Secret Manager.

---

## 📁 Directory Structure

- `/server.ts`: The full-stack Express Server powering the custom agentic processing pipeline.
- `/src/`: React visual companion companion console, containing interactive charts, drag-and-drop file ingestion, pipeline editor, and config explorers.
- `/terraform/`: Infrastructure-as-code files:
  - `main.tf`: Declares VPC networks, firewall parameters, serverless access connectors, postgres vector databases, and container host policies.
  - `providers.tf`, `variables.tf`, `outputs.tf`: Full terraform config structures.
- `/.github/workflows/deploy.yml`: Production CI/CD workflow pushing code to Google Cloud Run and executing `terraform apply` seamlessly on commit.

---

## 🚀 Local Quickstart

### 1. Configure Secrets
Ensure you have your Gemini API secret key. Copy `.env.example` to `.env` :
```bash
cp .env.example .env
```
Specify your `GEMINI_API_KEY` inside `.env`.

### 2. Live Dev Server
Run the development environment locally (port 3000):
```bash
npm install
npm run dev
```
Open your browser at `http://localhost:3000`.

---

## ☁️ Cloud Provisioning via Terraform

To spin up this entire low-cost ecosystem in your Google Cloud Project:

```bash
cd terraform

# Initialize terraform plugins
terraform init

# Review the planned list of resources
terraform plan \
  -var="project_id=YOUR_PROJECT_ID" \
  -var="db_password=YOUR_SECURE_PASSWORD" \
  -var="gemini_api_key=YOUR_GEMINI_KEY"

# Provision infrastructure on GCP
terraform apply \
  -var="project_id=YOUR_PROJECT_ID" \
  -var="db_password=YOUR_SECURE_PASSWORD" \
  -var="gemini_api_key=YOUR_GEMINI_KEY"\
  -auto-approve
```

---

## 🔄 CI/CD Git Deployment
To deploy automatically on every code push:
1. Configure your GitHub repository.
2. Set up GitHub Secrets:
   - `GCP_PROJECT_ID`: Your target Google Cloud project identifier.
   - `GCP_SA_KEY`: JSON service account credential string that has permissions for Cloud Run Admin, Storage Admin, and SQL Admin.
   - `GCP_DB_PASSWORD`: Secure text password for postgres vector instance admin.
   - `GEMINI_API_KEY`: Your Gemini credentials used server-side.
3. Push to `main` branch to trigger the action.
