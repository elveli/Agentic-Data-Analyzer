variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "The AWS region to deploy all serverless compute and database infrastructure."
}

variable "app_name" {
  type        = string
  default     = "agentic-data-analyzer"
  description = "Name of the agentic data processing application."
}

variable "db_password" {
  type        = string
  sensitive   = true
  description = "The RDS PostgreSQL database master password with PGVECTOR support."
}

variable "gemini_api_key" {
  type        = string
  sensitive   = true
  description = "Google Gemini API Key for serverless logic reasoning."
}

