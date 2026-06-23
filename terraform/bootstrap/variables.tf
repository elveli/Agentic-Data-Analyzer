variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region to create the Terraform state bucket and lock table in."
}

variable "app_name" {
  type        = string
  default     = "agentic-data-analyzer"
  description = "Name of the application these backend resources belong to."
}

variable "state_bucket_name" {
  type        = string
  description = "Globally-unique S3 bucket name to store Terraform state in (e.g. \"agentic-data-analyzer-tfstate-<your-account-id>\")."
}

variable "lock_table_name" {
  type        = string
  default     = "agentic-data-analyzer-tf-locks"
  description = "DynamoDB table name used for Terraform state locking."
}
