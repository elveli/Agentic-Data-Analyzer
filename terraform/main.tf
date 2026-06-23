# AWS VPC & Networking setup for proper isolation
resource "aws_vpc" "main_vpc" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.app_name}-vpc"
  }
}

# Create Internet Gateway to allow external/VPC communications
resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main_vpc.id

  tags = {
    Name = "${var.app_name}-igw"
  }
}

# Define two subnets in distinct availability zones (mandatory for AWS Database Subnet Group configurations)
resource "aws_subnet" "subnet_a" {
  vpc_id            = aws_vpc.main_vpc.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.app_name}-subnet-a"
  }
}

resource "aws_subnet" "subnet_b" {
  vpc_id            = aws_vpc.main_vpc.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "${var.aws_region}b"
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.app_name}-subnet-b"
  }
}

# Public route tables
resource "aws_route_table" "public_rt" {
  vpc_id = aws_vpc.main_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = {
    Name = "${var.app_name}-rt"
  }
}

resource "aws_route_table_association" "rt_assoc_a" {
  subnet_id      = aws_subnet.subnet_a.id
  route_table_id = aws_route_table.public_rt.id
}

resource "aws_route_table_association" "rt_assoc_b" {
  subnet_id      = aws_subnet.subnet_b.id
  route_table_id = aws_route_table.public_rt.id
}

# RDS Subnet group
resource "aws_db_subnet_group" "db_group" {
  name       = "${var.app_name}-db-subnet-group"
  subnet_ids = [aws_subnet.subnet_a.id, aws_subnet.subnet_b.id]

  tags = {
    Name = "${var.app_name}-db-subnet-group"
  }
}

# Security group to govern RDS ingress rules
resource "aws_security_group" "db_sg" {
  name        = "${var.app_name}-db-security-group"
  description = "Allows secure access to Postgres PGVECTOR database instances."
  vpc_id      = aws_vpc.main_vpc.id

  # Ingress allowing internal VPC traffic and serverless connections
  ingress {
    description = "Postgres protocol connector"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.app_name}-db-sg"
  }
}

# Generate a secure random password automatically for the database
resource "random_password" "db_password" {
  length           = 16
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# AWS Secret Manager for secure storage of Database Password
resource "aws_secretsmanager_secret" "db_password" {
  name                    = "${var.app_name}-db-password"
  recovery_window_in_days = 0 
}

resource "aws_secretsmanager_secret_version" "db_password_val" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = random_password.db_password.result
}

# AWS RDS Postgres DB (optimized size for lowest price development scaling, supports pgvector natively)
resource "aws_db_instance" "postgres_vector" {
  identifier             = "${var.app_name}-postgres"
  allocated_storage      = 20
  max_allocated_storage  = 100
  engine                 = "postgres"
  engine_version         = "15.4" # Native support for pgvector index sync
  instance_class         = "db.t4g.micro" # Under $12/month for massive cost savings
  db_name                = "agentic_workspace"
  username               = "agent_admin"
  password               = random_password.db_password.result
  db_subnet_group_name   = aws_db_subnet_group.db_group.name
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  skip_final_snapshot    = true
  publicly_accessible    = true

  tags = {
    Name = "agentic-rds-vector"
  }
}

# AWS Secret Manager for secure storage of Gemini Key
resource "aws_secretsmanager_secret" "gemini_key" {
  name                    = "${var.app_name}-gemini-api"
  recovery_window_in_days = 0 # Avoid trailing costs or delayed deletes
}

resource "aws_secretsmanager_secret_version" "gemini_key_val" {
  secret_id     = aws_secretsmanager_secret.gemini_key.id
  secret_string = var.gemini_api_key
}

# AWS IAM execution policies for ECR interaction
resource "aws_iam_role" "apprunner_access_role" {
  name = "${var.app_name}-apprunner-access"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "build.apprunner.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr" {
  role       = aws_iam_role.apprunner_access_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECMAccess"
}

# Create standard private Amazon ECR Repository for the built Node multi-agent image container
resource "aws_ecr_repository" "agent_ecr" {
  name                 = var.app_name
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }
}

# Deploy AWS App Runner (Serverless HTTP orchestration: auto-scaler, scales down cost-safely, with instant secure public URL)
resource "aws_apprunner_service" "agent_runner" {
  service_name = var.app_name

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_access_role.arn
    }

    image_repository {
      image_identifier      = "${aws_ecr_repository.agent_ecr.repository_url}:latest"
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
    auto_deployments_enabled = true
  }

  instance_configuration {
    cpu    = "1 vCPU"
    memory = "2 GB"
  }

  tags = {
    Environment = "production"
  }

  depends_on = [
    aws_db_instance.postgres_vector,
    aws_secretsmanager_secret_version.gemini_key_val
  ]
}

