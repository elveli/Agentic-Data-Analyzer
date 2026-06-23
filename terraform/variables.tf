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

variable "gemini_api_key" {
  type        = string
  sensitive   = true
  description = "Google Gemini API Key for serverless logic reasoning. Pass via TF_VAR_gemini_api_key or terraform.tfvars."

  validation {
    condition     = length(trimspace(var.gemini_api_key)) > 0
    error_message = "gemini_api_key must be set. Export TF_VAR_gemini_api_key or add it to terraform.tfvars before applying."
  }
}

