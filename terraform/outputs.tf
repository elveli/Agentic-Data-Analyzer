output "app_url" {
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
}

