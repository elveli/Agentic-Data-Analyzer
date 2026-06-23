output "app_url" {
  value       = "http://${aws_lb.main.dns_name}"
  description = "The public web URL of the AWS ECS Fargate automated analytics agent."
}

output "vector_db_address" {
  value       = aws_db_instance.postgres_vector.address
  description = "The endpoint address of the RDS PostgreSQL PGVECTOR database."
}

output "database_name" {
  value       = aws_db_instance.postgres_vector.db_name
  description = "The relational and vector schema container database name."
}

