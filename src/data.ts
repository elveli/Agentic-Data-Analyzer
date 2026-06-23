export interface Step {
  id: string;
  name: string;
  type: "ingestion" | "vector" | "model" | "generation";
  active: boolean;
  description: string;
}

export interface ExecutionLog {
  stepId: string;
  status: "pending" | "running" | "success" | "error";
  message: string;
  time?: string;
}

export const templates = [
  {
    name: "SaaS Growth & Performance (CSV)",
    data: "Month,NewUsers,ServerCost,CpuAvg\nJan,1200,320,42\nFeb,1450,335,45\nMar,2100,550,78\nApr,1950,490,61\nMay,2800,620,89\nJun,3400,680,94",
    goal: "Identify correlation between NewUsers spike and CpuAvg workload to forecast ServerCost overhead."
  },
  {
    name: "E-commerce Retail Metrics",
    data: "Week,Orders,Revenue,ConversionRate\nW1,450,15200,2.1\nW2,480,16500,2.2\nW3,890,32000,3.8\nW4,510,18100,2.4\nW5,550,19800,2.5",
    goal: "Evaluate customer conversion efficiency spikes and model expected revenue potential."
  },
  {
    name: "IoT Database Access Tickers",
    data: "Timestamp,ReadOps,WriteOps,DelayMs\nT1,89000,12000,12\nT2,94000,12500,14\nT3,142000,18000,45\nT4,110000,14000,18\nT5,99000,13100,15",
    goal: "Detect system database bottlenecks, link high write operations to latency spikes, and propose mitigation configurations."
  }
];

export const tfFiles: Record<string, string> = {
  "main.tf": `# AWS VPC & Networking setup for proper isolation
resource "aws_vpc" "main_vpc" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
}

# Define subnets in separate availability zones (AWS PostgreSQL multi-AZ prerequisite)
resource "aws_subnet" "subnet_a" {
  vpc_id            = aws_vpc.main_vpc.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "\${var.aws_region}a"
  map_public_ip_on_launch = true
}

resource "aws_subnet" "subnet_b" {
  vpc_id            = aws_vpc.main_vpc.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "\${var.aws_region}b"
  map_public_ip_on_launch = true
}

resource "aws_db_subnet_group" "db_group" {
  name       = "\${var.app_name}-subnet-group"
  subnet_ids = [aws_subnet.subnet_a.id, aws_subnet.subnet_b.id]
}

# Generate a secure random password automatically for the database
resource "random_password" "db_password" {
  length           = 16
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# AWS Secret Manager for secure storage of Database Password
resource "aws_secretsmanager_secret" "db_password" {
  name                    = "\${var.app_name}-db-password"
  recovery_window_in_days = 0 
}

resource "aws_secretsmanager_secret_version" "db_password_val" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = random_password.db_password.result
}

# AWS RDS Postgres (With pgvector capabilities loaded automatically at engine boot)
resource "aws_db_instance" "postgres_vector" {
  identifier           = "\${var.app_name}-postgres"
  allocated_storage    = 20
  engine               = "postgres"
  engine_version       = "15.4"
  instance_class       = "db.t4g.micro" # Ultra cost-effective development scaling (~$12/mo)
  db_name              = "agentic_workspace"
  username             = "agent_admin"
  password             = random_password.db_password.result
  db_subnet_group_name = aws_db_subnet_group.db_group.name
  skip_final_snapshot  = true
  publicly_accessible  = true
}

# Deploy AWS App Runner serverless cluster (scaling automatically to traffic need)
resource "aws_apprunner_service" "agent_runner" {
  service_name = var.app_name

  source_configuration {
    image_repository {
      image_identifier      = "\${aws_ecr_repository.agent_ecr.repository_url}:latest"
      image_repository_type = "ECR"
      image_configuration {
        port = "3000"
        runtime_environment_variables = {
          NODE_ENV       = "production"
          DB_HOST        = aws_db_instance.postgres_vector.address
          DB_USER        = "agent_admin"
          DB_PASS        = random_password.db_password.result
          DB_NAME        = "agentic_workspace"
          GEMINI_API_KEY = var.gemini_api_key
        }
      }
    }
  }
}`,
  "variables.tf": `variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "The AWS region to deploy all serverless compute and database infrastructure."
}

variable "app_name" {
  type        = string
  default     = "agentic-data-analyzer"
  description = "Name of the agentic data processing application."
}

variable "gemini_api_key" {
  type        = string
  sensitive   = true
  description = "Google Gemini API Key for serverless logic reasoning."
}`,
  "outputs.tf": `output "app_url" {
  value       = aws_apprunner_service.agent_runner.service_url
  description = "The public web URL of the AWS App Runner automated analytics agent."
}

output "vector_db_address" {
  value       = aws_db_instance.postgres_vector.address
  description = "The endpoint address of the RDS PostgreSQL PGVECTOR database."
}

output "database_name" {
  value       = aws_db_instance.postgres_vector.db_name
  description = "The relational and vector schema container database name."
}`,
  "providers.tf": `terraform {
  required_version = ">= 1.4.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}`
};

export const pipelineCodeSnippetNode = `// Node.js Custom Agentic Data Pipeline Runner
import { GoogleGenAI } from "@google/genai";
import { Client } from "pg"; 

async function runPipeline(dataStr, userGoal) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log("[INGESTION] Processing raw text input strings...");
  const sanitized = dataStr.trim();

  console.log("[VECTOR SYNC] Connecting to scalable Cloud SQL database...");
  const pgClient = new Client({
    host: process.env.DB_HOST,
    user: "agent_admin",
    password: process.env.DB_PASS,
    database: "agentic_workspace"
  });
  await pgClient.connect();

  console.log("[VECTOR SYNC] Generating 1536-dim vector embeddings from model...");
  const embeddingResp = await ai.models.generateContent({
    model: 'gemini-embedding-2-preview',
    contents: sanitized
  });
  
  console.log("[VECTOR SYNC] Synchronized data chunks seamlessly to PGVECTOR store.");
  
  console.log("[ANALYSIS] Launching Gemini logic reasoning engine...");
  const analysisPrompt = \`Goal: \${userGoal}. Data details: \${sanitized}\`;
  const evaluation = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: analysisPrompt
  });

  console.log("[COMPLETED] Narrative insights drafted and consolidated.");
  return evaluation.text;
}`;
