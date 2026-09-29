# ☁️ Serverless Cloud File Upload & Processing System

> **AWS S3 + AWS Lambda Image Thumbnail Pipeline**  
> **Student:** Adarsh Mund  
> **Institute:** Centurion University of Technology and Management  
> **Project Type:** 10-Day Cloud Computing Major Project (Days 8 – 10)  
> **Runtime:** Python 3.12 · AWS Lambda · Amazon S3 · CloudWatch · IAM  

---

## 📋 Table of Contents

1. [Project Overview](#-project-overview)
2. [Architecture Diagram](#-architecture-diagram)
3. [AWS Service Mapping](#-aws-service-mapping)
4. [Repository Structure](#-repository-structure)
5. [Prerequisites](#-prerequisites)
6. [Deployment Instructions](#-deployment-instructions)
7. [Lambda Configuration](#-lambda-configuration)
8. [S3 Bucket Setup](#-s3-bucket-setup)
9. [IAM Role & Permissions](#-iam-role--permissions)
10. [Testing the Pipeline](#-testing-the-pipeline)
11. [Environment Variables](#-environment-variables)
12. [Output Artifacts](#-output-artifacts)
13. [Security Best Practices](#-security-best-practices)
14. [Cost Estimation](#-cost-estimation)
15. [Troubleshooting](#-troubleshooting)

---

## 🚀 Project Overview

This project implements a **fully serverless, event-driven image processing pipeline** on AWS. When a user uploads a JPG, PNG, or WebP image to an **Amazon S3** bucket, an **S3 Event Notification** automatically triggers an **AWS Lambda** function written in Python. The Lambda function:

1. Downloads the source image from S3 using `boto3`.
2. Generates a **200 × 200 pixel thumbnail** using the **Pillow (PIL)** library with Lanczos resampling for maximum quality.
3. Uploads the thumbnail back to S3 under the `processed/thumb_<filename>` key.
4. Generates a structured **metadata JSON** document (dimensions, byte sizes, format, execution time) and stores it at `processed/meta_<filename>.json`.
5. Streams structured logs to **Amazon CloudWatch Logs** for observability.

A modern dark-mode **frontend** (pure HTML/CSS/JS, no framework dependencies) provides:
- Drag-and-drop upload interface
- Live simulated pipeline execution trace
- Side-by-side image comparison (original vs thumbnail)
- Dynamic metadata key-value table
- S3 event JSON viewer
- AWS architecture map

---

## 🏗️ Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLIENT BROWSER                               │
│                                                                      │
│   ┌─────────────────┐      Drag & Drop / Click to Browse            │
│   │  index.html     │──────────────────────────────────────────┐    │
│   │  style.css      │                                           │    │
│   │  app.js         │◄─────── Results displayed ───────────────┤    │
│   └─────────────────┘                                           │    │
└─────────────────────────────────────────────────────────────────┼────┘
                                                                  │
                          HTTPS PUT (presigned URL / direct)      │
                                                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        AMAZON S3 BUCKET                             │
│   adarsh-cloud-uploads-bucket  (ap-south-1)                         │
│                                                                     │
│   uploads/                                                          │
│   └── photo.jpg        ◄── User upload lands here                  │
│                                                                     │
│   processed/            ◄── Lambda output goes here                │
│   ├── thumb_photo.jpg                                               │
│   └── meta_photo.json                                               │
│                                                                     │
│   [S3 Event Notification: ObjectCreated → Lambda]                   │
└────────────────────────────┬────────────────────────────────────────┘
                             │  S3 Event Record (JSON payload)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        AWS LAMBDA                                   │
│   Function : image-processing-pipeline                              │
│   Runtime  : Python 3.12                                            │
│   Timeout  : 30 seconds                                             │
│   Memory   : 512 MB                                                 │
│                                                                     │
│   lambda_function.py                                                │
│   ├── Extracts bucket + key from event['Records'][0]                │
│   ├── Recursion guard: skip 'processed/' prefix                     │
│   ├── Downloads image via s3_client.get_object()                   │
│   ├── Opens image with Pillow (PIL)                                 │
│   ├── thumbnail(200×200, LANCZOS resampling)                        │
│   ├── s3_client.put_object() → processed/thumb_<key>               │
│   └── s3_client.put_object() → processed/meta_<key>.json           │
└────────────┬──────────────────────────────────┬────────────────────┘
             │                                  │
             ▼                                  ▼
┌────────────────────────┐       ┌──────────────────────────────────┐
│  Amazon CloudWatch     │       │         Amazon S3 (same bucket)  │
│  Logs                  │       │                                  │
│  /aws/lambda/image-    │       │  processed/thumb_photo.jpg       │
│  processing-pipeline   │       │  processed/meta_photo.json       │
│                        │       │                                  │
│  ● INFO log entries    │       │  Metadata JSON:                  │
│  ● Timing metrics      │       │  { dimensions, size, format,     │
│  ● Error traces        │       │    reduction%, latency_ms }      │
└────────────────────────┘       └──────────────────────────────────┘
```

---

## 🔧 AWS Service Mapping

| AWS Service | Role in This Project | Key Resource |
|---|---|---|
| **Amazon S3** | Primary object store — source images and processed output | `adarsh-cloud-uploads-bucket` |
| **AWS Lambda** | Event-driven compute — Python image processing | `image-processing-pipeline` |
| **Amazon CloudWatch Logs** | Centralized logging and metrics for Lambda | `/aws/lambda/image-processing-pipeline` |
| **AWS IAM** | Least-privilege execution role for Lambda | `LambdaImageProcessingRole` |
| **S3 Event Notifications** | Trigger mechanism connecting S3 → Lambda | `ObjectCreated:*` on prefix `uploads/` |

---

## 📁 Repository Structure

```
Serverless Cloud File Upload & Processing System/
│
├── frontend/
│   ├── index.html          # Main UI — dark-mode, drag-and-drop, results display
│   ├── style.css           # Cyber-slate theme — responsive, card-based layout
│   └── app.js              # Client handlers, pipeline simulation, telemetry table
│
├── lambda/
│   └── lambda_function.py  # AWS Lambda handler — S3 trigger, Pillow thumbnail
│
└── README.md               # This file
```

---

## 📦 Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.12+ | Lambda runtime |
| AWS CLI | v2.x | Configured with IAM credentials |
| Pillow (PIL) | 10.x | Must be packaged in Lambda deployment ZIP |
| boto3 | 1.34+ | Included in Lambda runtime — no packaging needed |
| AWS Account | — | With S3 and Lambda service access |

---

## 🚢 Deployment Instructions

### Step 1 — Create the S3 Bucket

```bash
aws s3api create-bucket \
  --bucket adarsh-cloud-uploads-bucket \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

# Block all public access (security best practice)
aws s3api put-public-access-block \
  --bucket adarsh-cloud-uploads-bucket \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,\
    BlockPublicPolicy=true,RestrictPublicBuckets=true
```

### Step 2 — Create IAM Role for Lambda

```bash
# Create trust policy
cat > trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

# Create the role
aws iam create-role \
  --role-name LambdaImageProcessingRole \
  --assume-role-policy-document file://trust-policy.json

# Attach CloudWatch Logs managed policy
aws iam attach-role-policy \
  --role-name LambdaImageProcessingRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Attach inline S3 policy (least privilege)
cat > s3-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSourceImages",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::adarsh-cloud-uploads-bucket/uploads/*"
    },
    {
      "Sid": "WriteProcessedOutput",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::adarsh-cloud-uploads-bucket/processed/*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name LambdaImageProcessingRole \
  --policy-name S3ImageProcessingPolicy \
  --policy-document file://s3-policy.json
```

### Step 3 — Package the Lambda Function

The Pillow library is **not** pre-installed in the Lambda environment and must be bundled:

```bash
# Create a clean packaging directory
mkdir -p lambda_package

# Install Pillow for Linux/Lambda architecture
pip install pillow \
  --platform manylinux2014_x86_64 \
  --target ./lambda_package \
  --implementation cp \
  --python-version 3.12 \
  --only-binary=:all: \
  --upgrade

# Copy the function
cp lambda/lambda_function.py lambda_package/

# Create ZIP archive
cd lambda_package
zip -r ../image_pipeline.zip .
cd ..
```

> **Note:** If deploying to ARM64 (Graviton2), change the platform to `manylinux2014_aarch64`.

### Step 4 — Deploy Lambda Function

```bash
# Get your account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws lambda create-function \
  --function-name image-processing-pipeline \
  --runtime python3.12 \
  --role arn:aws:iam::${ACCOUNT_ID}:role/LambdaImageProcessingRole \
  --handler lambda_function.lambda_handler \
  --zip-file fileb://image_pipeline.zip \
  --timeout 30 \
  --memory-size 512 \
  --region ap-south-1 \
  --environment Variables='{
    "THUMB_WIDTH":"200",
    "THUMB_HEIGHT":"200",
    "PROCESSED_PREFIX":"processed/",
    "THUMB_PREFIX":"thumb_",
    "META_PREFIX":"meta_"
  }'
```

### Step 5 — Add S3 Trigger Permission

```bash
aws lambda add-permission \
  --function-name image-processing-pipeline \
  --statement-id S3InvokeLambda \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::adarsh-cloud-uploads-bucket \
  --source-account ${ACCOUNT_ID}
```

### Step 6 — Configure S3 Event Notification

```bash
cat > notification.json << 'EOF'
{
  "LambdaFunctionConfigurations": [{
    "LambdaFunctionArn": "REPLACE_WITH_LAMBDA_ARN",
    "Events": ["s3:ObjectCreated:*"],
    "Filter": {
      "Key": {
        "FilterRules": [
          { "Name": "prefix", "Value": "uploads/" },
          { "Name": "suffix", "Value": "" }
        ]
      }
    }
  }]
}
EOF

# Replace ARN and apply
LAMBDA_ARN=$(aws lambda get-function --function-name image-processing-pipeline \
  --query 'Configuration.FunctionArn' --output text)

sed -i "s|REPLACE_WITH_LAMBDA_ARN|${LAMBDA_ARN}|g" notification.json

aws s3api put-bucket-notification-configuration \
  --bucket adarsh-cloud-uploads-bucket \
  --notification-configuration file://notification.json
```

---

## ⚙️ Lambda Configuration

| Parameter | Value | Reason |
|---|---|---|
| Runtime | `python3.12` | Latest stable Python Lambda runtime |
| Handler | `lambda_function.lambda_handler` | Entry point |
| Timeout | `30 seconds` | Handles up to ~10 MB images comfortably |
| Memory | `512 MB` | Pillow image processing requires adequate heap |
| Architecture | `x86_64` | Compatible with `manylinux` Pillow wheels |
| Concurrency | Default (unreserved) | Scales automatically with S3 events |

---

## 🪣 S3 Bucket Setup

| Prefix | Purpose |
|---|---|
| `uploads/` | Drop zone for raw user-uploaded images |
| `processed/thumb_*` | Lambda-generated 200×200 thumbnails |
| `processed/meta_*.json` | Processing metadata JSON documents |

**Lifecycle rule recommendation:** Set an S3 lifecycle policy to transition `processed/` objects to **S3 Glacier Instant Retrieval** after 90 days to minimize storage costs.

---

## 🔑 IAM Role & Permissions

The Lambda execution role follows the **principle of least privilege**:

```
LambdaImageProcessingRole
├── AWSLambdaBasicExecutionRole  (managed policy)
│   └── logs:CreateLogGroup
│   └── logs:CreateLogStream
│   └── logs:PutLogEvents
│
└── S3ImageProcessingPolicy  (inline policy)
    ├── s3:GetObject  → adarsh-cloud-uploads-bucket/uploads/*
    └── s3:PutObject  → adarsh-cloud-uploads-bucket/processed/*
```

> **Security Note:** The role does NOT grant `s3:ListBucket`, `s3:DeleteObject`, or cross-bucket access.

---

## 🧪 Testing the Pipeline

### Manual Upload Test

```bash
# Upload a test image
aws s3 cp /path/to/test-photo.jpg \
  s3://adarsh-cloud-uploads-bucket/uploads/test-photo.jpg

# Wait ~2-3 seconds, then verify output
aws s3 ls s3://adarsh-cloud-uploads-bucket/processed/
# Expected output:
# thumb_test-photo.jpg
# meta_test-photo.json

# Download and inspect metadata
aws s3 cp s3://adarsh-cloud-uploads-bucket/processed/meta_test-photo.json - | python -m json.tool
```

### CloudWatch Log Verification

```bash
# List log streams for the function
aws logs describe-log-streams \
  --log-group-name /aws/lambda/image-processing-pipeline \
  --order-by LastEventTime \
  --descending \
  --limit 3

# Tail the most recent stream
aws logs get-log-events \
  --log-group-name /aws/lambda/image-processing-pipeline \
  --log-stream-name <STREAM_NAME_FROM_ABOVE> \
  --limit 50
```

### Local Unit Test

```bash
# Install dependencies locally for testing
pip install pillow boto3 moto pytest

# Run a mock test (requires moto for AWS mocking)
python -c "
import json
from unittest.mock import MagicMock
context = MagicMock()
context.function_name = 'image-processing-pipeline'
context.function_version = '\$LATEST'
context.aws_request_id = 'test-request-001'
print('Lambda module imports successfully.')
from lambda.lambda_function import lambda_handler
print('Handler callable:', callable(lambda_handler))
"
```

---

## 🌐 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `THUMB_WIDTH` | `200` | Thumbnail max width in pixels |
| `THUMB_HEIGHT` | `200` | Thumbnail max height in pixels |
| `PROCESSED_PREFIX` | `processed/` | S3 key prefix for output objects |
| `THUMB_PREFIX` | `thumb_` | Filename prefix for thumbnail objects |
| `META_PREFIX` | `meta_` | Filename prefix for metadata JSON objects |

---

## 📄 Output Artifacts

### Thumbnail (`processed/thumb_<filename>`)

- Format: same as source (JPEG / PNG / WebP)
- Dimensions: ≤ 200 × 200 px (aspect ratio preserved)
- JPEG quality: 85 (optimized)
- PNG compression: level 7 (optimized)
- WebP quality: 80

### Metadata JSON (`processed/meta_<filename>.json`)

```json
{
  "schema_version": "1.0",
  "generated_at": "2026-09-27T11:36:02.000Z",
  "lambda_request_id": "abc123-...",
  "status": "SUCCESS",
  "error": null,
  "source": {
    "bucket": "adarsh-cloud-uploads-bucket",
    "key": "uploads/photo.jpg",
    "size_bytes": 2048000,
    "size_human": "2.0 MB",
    "width": 3840,
    "height": 2160,
    "format": "JPEG",
    "color_mode": "RGB"
  },
  "thumbnail": {
    "bucket": "adarsh-cloud-uploads-bucket",
    "key": "processed/thumb_photo.jpg",
    "size_bytes": 8192,
    "size_human": "8.0 KB",
    "width": 200,
    "height": 113
  },
  "metrics": {
    "size_reduction_pct": "99.60%",
    "execution_ms": 1240,
    "thumbnail_spec": "200x200"
  }
}
```

---

## 🔒 Security Best Practices

### 1. Bucket Access Control
- ✅ Block all public access on the S3 bucket.
- ✅ Enable **S3 Server-Side Encryption** (SSE-S3 or SSE-KMS) for data at rest.
- ✅ Enable **S3 Versioning** to protect against accidental overwrites.
- ✅ Enable **S3 Access Logging** to an audit bucket.

### 2. Lambda Security
- ✅ Use the **least-privilege IAM role** — only `GetObject` from `uploads/` and `PutObject` to `processed/`.
- ✅ Do **not** hardcode credentials. Lambda inherits the execution role automatically.
- ✅ Set a **reasonable timeout** (30 s) to prevent runaway executions.
- ✅ Enable **Lambda code signing** to ensure only verified packages are deployed.

### 3. Recursion Guard
The Lambda includes a critical guard at the top of `_process_record()`:

```python
if source_key.startswith(PROCESSED_PREFIX):
    logger.warning("Skipping key — recursion guard.")
    return None
```

This prevents an **infinite trigger loop**: if the event notification were accidentally configured on `processed/`, Lambda would trigger itself indefinitely.

### 4. Input Validation
- ✅ Only `JPEG`, `PNG`, and `WebP` formats are accepted — others raise `ValueError`.
- ✅ `PIL.UnidentifiedImageError` is caught and handled gracefully.
- ✅ Pillow's `thumbnail()` does not upscale — prevents memory exhaustion on tiny inputs.

### 5. Monitoring
- ✅ Enable **CloudWatch Alarms** on `Errors` and `Duration` metrics for the Lambda function.
- ✅ Set a **Dead Letter Queue (DLQ)** (SQS or SNS) to capture failed invocations.
- ✅ Use **AWS X-Ray** tracing on Lambda for distributed latency analysis.

---

## 💰 Cost Estimation

> All estimates assume the AWS **Free Tier** where applicable.

| Service | Free Tier | Estimated Monthly Cost (100 uploads/day) |
|---|---|---|
| AWS Lambda | 1M requests / 400,000 GB-s free | \$0.00 (within free tier) |
| Amazon S3 | 5 GB storage / 20,000 GET / 2,000 PUT | ~\$0.02 (storage only) |
| CloudWatch Logs | 5 GB ingestion free | \$0.00 |
| Data Transfer (egress) | 1 GB free | < \$0.01 |

**Total estimated cost: < \$0.05/month** for a typical student workload.

---

## 🛠️ Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Lambda not triggered | S3 notification not configured | Re-run Step 6; verify prefix filter |
| `NoSuchKey` error | Image uploaded to wrong prefix | Ensure upload goes to `uploads/` prefix |
| `ModuleNotFoundError: PIL` | Pillow not in ZIP package | Re-run Step 3 with `--only-binary=:all:` |
| Infinite loop / high cost | S3 event on `processed/` prefix | Add recursion guard check; restrict prefix filter to `uploads/` only |
| Timeout errors | Image > 10 MB or very high resolution | Increase Lambda timeout; add file size validation at upload |
| `AccessDenied` on PutObject | IAM role missing `s3:PutObject` | Re-apply the inline S3 policy (Step 2) |
| Thumbnail looks blurry | Low quality setting | Increase JPEG quality to 90 in `save_kwargs` |

---

## 📚 References

- [AWS Lambda Developer Guide](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)
- [Amazon S3 Event Notifications](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html)
- [Pillow (PIL Fork) Documentation](https://pillow.readthedocs.io/en/stable/)
- [boto3 S3 API Reference](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/s3.html)
- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)

---

*Generated for **Adarsh Mund** | Centurion University of Technology and Management*  
*10-Day Cloud Computing Major Project — Serverless Architecture Track*
