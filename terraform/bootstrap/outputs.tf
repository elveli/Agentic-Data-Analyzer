output "state_bucket_name" {
  value       = aws_s3_bucket.tf_state.id
  description = "Pass this as `bucket` in backend.hcl / -backend-config."
}

output "lock_table_name" {
  value       = aws_dynamodb_table.tf_locks.name
  description = "Pass this as `dynamodb_table` in backend.hcl / -backend-config."
}
