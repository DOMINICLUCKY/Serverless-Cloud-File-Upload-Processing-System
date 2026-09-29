"""
=============================================================================
  Serverless Cloud File Upload & Processing System
  AWS Lambda Function — S3-Triggered Image Processing Pipeline
  Student  : Adarsh Mund
  Institute: Centurion University of Technology and Management
  Project  : 10-Day Cloud Computing Major Project (Day 8-10)
  Runtime  : Python 3.12
  Services : Amazon S3 · AWS Lambda · Amazon CloudWatch Logs · AWS IAM
=============================================================================

Architecture Flow
-----------------
  User Browser
      │  (PUT object)
      ▼
  S3 Bucket (uploads/)
      │  (S3 Event Notification → trigger)
      ▼
  AWS Lambda (this function)
      │
      ├─► Download original image from S3
      ├─► Generate 200×200 thumbnail (Pillow / PIL)
      ├─► Upload thumbnail  → s3://bucket/processed/thumb_<key>
      └─► Upload metadata   → s3://bucket/processed/meta_<key>.json

IAM Permissions Required (attach to Lambda execution role)
-----------------------------------------------------------
  s3:GetObject      — read source image
  s3:PutObject      — write thumbnail + metadata JSON
  logs:CreateLogGroup
  logs:CreateLogStream
  logs:PutLogEvents — CloudWatch logging
=============================================================================
"""

import io
import json
import logging
import os
import time
import urllib.parse
from datetime import datetime, timezone

import boto3
from PIL import Image, UnidentifiedImageError

# ---------------------------------------------------------------------------
# Logging — CloudWatch Logs picks these up automatically
# ---------------------------------------------------------------------------
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# Constants — override via Lambda Environment Variables for flexibility
# ---------------------------------------------------------------------------
THUMBNAIL_SIZE    = (
    int(os.environ.get("THUMB_WIDTH",  "200")),
    int(os.environ.get("THUMB_HEIGHT", "200")),
)
PROCESSED_PREFIX  = os.environ.get("PROCESSED_PREFIX", "processed/")
THUMB_PREFIX      = os.environ.get("THUMB_PREFIX",     "thumb_")
META_PREFIX       = os.environ.get("META_PREFIX",      "meta_")
SUPPORTED_FORMATS = {"JPEG", "PNG", "WEBP"}

# ---------------------------------------------------------------------------
# AWS clients — created once outside the handler for connection re-use
# ---------------------------------------------------------------------------
s3_client = boto3.client("s3")


# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------

def _format_bytes(n: int) -> str:
    """Human-readable byte size string."""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _pct_reduction(original: int, compressed: int) -> str:
    """Percentage size reduction between two byte counts."""
    if original == 0:
        return "0.00%"
    reduction = (1 - compressed / original) * 100
    return f"{reduction:.2f}%"


def _build_metadata(
    *,
    source_bucket: str,
    source_key:    str,
    thumb_key:     str,
    original_size: int,
    thumb_size:    int,
    orig_dims:     tuple,
    thumb_dims:    tuple,
    img_format:    str,
    img_mode:      str,
    execution_ms:  int,
    request_id:    str,
    status:        str,
    error_msg:     str = None,
) -> dict:
    """Build a structured metadata dictionary persisted as JSON in S3."""
    return {
        "schema_version": "1.0",
        "generated_at":   datetime.now(timezone.utc).isoformat(),
        "lambda_request_id": request_id,
        "status":         status,
        "error":          error_msg,
        "source": {
            "bucket":       source_bucket,
            "key":          source_key,
            "size_bytes":   original_size,
            "size_human":   _format_bytes(original_size),
            "width":        orig_dims[0],
            "height":       orig_dims[1],
            "format":       img_format,
            "color_mode":   img_mode,
        },
        "thumbnail": {
            "bucket":       source_bucket,
            "key":          thumb_key,
            "size_bytes":   thumb_size,
            "size_human":   _format_bytes(thumb_size),
            "width":        thumb_dims[0],
            "height":       thumb_dims[1],
        },
        "metrics": {
            "size_reduction_pct": _pct_reduction(original_size, thumb_size),
            "execution_ms":       execution_ms,
            "thumbnail_spec":     f"{THUMBNAIL_SIZE[0]}x{THUMBNAIL_SIZE[1]}",
        },
    }


# ---------------------------------------------------------------------------
# Core processing logic
# ---------------------------------------------------------------------------

def _process_record(record: dict, context) -> dict:
    """
    Process a single S3 event record.

    Parameters
    ----------
    record  : dict  — one element from event['Records']
    context : LambdaContext — AWS Lambda context object

    Returns
    -------
    dict with keys: source_key, thumb_key, meta_key, metadata
    """
    start_ts = time.time()

    # ── 1. Extract bucket & key from the S3 event record ──────────────────
    source_bucket = record["s3"]["bucket"]["name"]
    # Keys may be URL-encoded (e.g. spaces → '+')
    source_key    = urllib.parse.unquote_plus(
        record["s3"]["object"]["key"]
    )

    logger.info(
        "Processing record | bucket=%s | key=%s | event=%s",
        source_bucket,
        source_key,
        record.get("eventName", "unknown"),
    )

    # ── 2. Safeguard: skip objects already inside the processed/ prefix ────
    #    Without this guard, the Lambda would trigger on its own output,
    #    creating an infinite recursive loop (and a very large AWS bill).
    if source_key.startswith(PROCESSED_PREFIX):
        logger.warning(
            "Skipping key '%s' — already inside '%s' prefix (recursion guard).",
            source_key,
            PROCESSED_PREFIX,
        )
        return None

    # ── 3. Download the source image from S3 ──────────────────────────────
    logger.info("Downloading s3://%s/%s", source_bucket, source_key)
    try:
        response    = s3_client.get_object(Bucket=source_bucket, Key=source_key)
        image_bytes = response["Body"].read()
        original_size = len(image_bytes)
    except s3_client.exceptions.NoSuchKey:
        raise FileNotFoundError(
            f"Object not found: s3://{source_bucket}/{source_key}"
        )

    logger.info(
        "Downloaded %s (%s bytes)", source_key, original_size
    )

    # ── 4. Open and validate the image ────────────────────────────────────
    try:
        image = Image.open(io.BytesIO(image_bytes))
    except UnidentifiedImageError as exc:
        raise ValueError(
            f"File is not a recognizable image format: {source_key}"
        ) from exc

    original_format = (image.format or "UNKNOWN").upper()
    original_mode   = image.mode
    original_dims   = image.size          # (width, height)

    logger.info(
        "Image opened | format=%s | mode=%s | dimensions=%dx%d",
        original_format, original_mode,
        original_dims[0], original_dims[1],
    )

    if original_format not in SUPPORTED_FORMATS:
        raise ValueError(
            f"Unsupported image format '{original_format}'. "
            f"Supported: {SUPPORTED_FORMATS}"
        )

    # ── 5. Generate thumbnail ──────────────────────────────────────────────
    #    Image.LANCZOS (Lanczos resampling) gives high-quality downscaling.
    #    thumbnail() preserves aspect ratio; it does NOT upscale.
    thumbnail = image.copy()
    thumbnail.thumbnail(THUMBNAIL_SIZE, Image.LANCZOS)
    thumb_dims = thumbnail.size

    # Convert palette / RGBA images to RGB so they can be saved as JPEG
    save_format = original_format
    if save_format == "JPEG" and thumbnail.mode in ("RGBA", "P"):
        thumbnail = thumbnail.convert("RGB")
    # WebP supports RGBA natively; PNG is fine as-is.

    logger.info(
        "Thumbnail generated | dimensions=%dx%d | format=%s",
        thumb_dims[0], thumb_dims[1], save_format,
    )

    # ── 6. Encode thumbnail to bytes ───────────────────────────────────────
    buffer = io.BytesIO()
    save_kwargs = {}
    if save_format == "JPEG":
        save_kwargs["quality"]   = 85
        save_kwargs["optimize"]  = True
    elif save_format == "PNG":
        save_kwargs["optimize"]  = True
        save_kwargs["compress_level"] = 7
    elif save_format == "WEBP":
        save_kwargs["quality"]   = 80

    thumbnail.save(buffer, format=save_format, **save_kwargs)
    thumb_bytes = buffer.getvalue()
    thumb_size  = len(thumb_bytes)

    # ── 7. Build destination keys ──────────────────────────────────────────
    #    Strip any leading path segments so nested uploads flatten correctly.
    base_filename = os.path.basename(source_key)          # e.g. "photo.jpg"
    thumb_key     = f"{PROCESSED_PREFIX}{THUMB_PREFIX}{base_filename}"
    meta_key      = (
        f"{PROCESSED_PREFIX}{META_PREFIX}"
        f"{os.path.splitext(base_filename)[0]}.json"
    )

    # ── 8. Upload thumbnail to S3 ──────────────────────────────────────────
    mime_map = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
    thumb_content_type = mime_map.get(save_format, "application/octet-stream")

    logger.info("Uploading thumbnail → s3://%s/%s", source_bucket, thumb_key)
    s3_client.put_object(
        Bucket      = source_bucket,
        Key         = thumb_key,
        Body        = thumb_bytes,
        ContentType = thumb_content_type,
        Metadata    = {
            "source-key":   source_key,
            "original-size": str(original_size),
            "thumb-spec":   f"{THUMBNAIL_SIZE[0]}x{THUMBNAIL_SIZE[1]}",
            "generated-by": "lambda-image-pipeline",
        },
    )
    logger.info(
        "Thumbnail uploaded | size=%s | reduction=%s",
        _format_bytes(thumb_size),
        _pct_reduction(original_size, thumb_size),
    )

    # ── 9. Build and upload metadata JSON ─────────────────────────────────
    execution_ms = int((time.time() - start_ts) * 1000)
    metadata = _build_metadata(
        source_bucket = source_bucket,
        source_key    = source_key,
        thumb_key     = thumb_key,
        original_size = original_size,
        thumb_size    = thumb_size,
        orig_dims     = original_dims,
        thumb_dims    = thumb_dims,
        img_format    = original_format,
        img_mode      = original_mode,
        execution_ms  = execution_ms,
        request_id    = context.aws_request_id,
        status        = "SUCCESS",
    )

    logger.info("Uploading metadata → s3://%s/%s", source_bucket, meta_key)
    s3_client.put_object(
        Bucket      = source_bucket,
        Key         = meta_key,
        Body        = json.dumps(metadata, indent=2),
        ContentType = "application/json",
        Metadata    = {
            "source-key": source_key,
            "generated-by": "lambda-image-pipeline",
        },
    )

    logger.info(
        "Pipeline complete | request_id=%s | latency=%dms",
        context.aws_request_id,
        execution_ms,
    )

    return {
        "source_key": source_key,
        "thumb_key":  thumb_key,
        "meta_key":   meta_key,
        "metadata":   metadata,
    }


# ---------------------------------------------------------------------------
# Lambda Handler Entry Point
# ---------------------------------------------------------------------------

def lambda_handler(event: dict, context) -> dict:
    """
    AWS Lambda entry point — invoked by S3 Event Notification.

    Parameters
    ----------
    event   : dict — S3 event payload containing 'Records' list
    context : LambdaContext — runtime metadata (request ID, function name…)

    Returns
    -------
    dict — HTTP-style response with statusCode and body
    """
    logger.info(
        "Lambda invoked | function=%s | version=%s | request_id=%s",
        context.function_name,
        context.function_version,
        context.aws_request_id,
    )
    logger.info("Raw event payload: %s", json.dumps(event))

    records = event.get("Records", [])
    if not records:
        logger.warning("No records found in event — nothing to process.")
        return {
            "statusCode": 200,
            "body": json.dumps({"message": "No records to process."}),
        }

    results  = []
    failures = []

    for idx, record in enumerate(records):
        logger.info(
            "Processing record %d/%d | source=%s",
            idx + 1, len(records),
            record.get("eventSource", "unknown"),
        )
        try:
            result = _process_record(record, context)
            if result is not None:        # None = skipped (recursion guard)
                results.append(result)
                logger.info(
                    "Record %d/%d processed successfully → %s",
                    idx + 1, len(records), result["thumb_key"],
                )
        except FileNotFoundError as exc:
            logger.error("Record %d/%d | FileNotFoundError: %s", idx + 1, len(records), exc)
            failures.append({"record_index": idx, "error": str(exc), "type": "FileNotFoundError"})
        except ValueError as exc:
            logger.error("Record %d/%d | ValueError: %s", idx + 1, len(records), exc)
            failures.append({"record_index": idx, "error": str(exc), "type": "ValueError"})
        except Exception as exc:          # pylint: disable=broad-except
            logger.exception(
                "Record %d/%d | Unexpected error: %s", idx + 1, len(records), exc
            )
            failures.append({"record_index": idx, "error": str(exc), "type": type(exc).__name__})

    response_body = {
        "processed": len(results),
        "skipped":   len(records) - len(results) - len(failures),
        "failed":    len(failures),
        "results":   [
            {
                "source_key": r["source_key"],
                "thumb_key":  r["thumb_key"],
                "meta_key":   r["meta_key"],
                "size_reduction": r["metadata"]["metrics"]["size_reduction_pct"],
                "execution_ms":   r["metadata"]["metrics"]["execution_ms"],
            }
            for r in results
        ],
        "failures": failures,
    }

    status_code = 200 if not failures else 207   # 207 Multi-Status on partial failure
    logger.info(
        "Handler complete | processed=%d | failed=%d | status=%d",
        len(results), len(failures), status_code,
    )

    return {
        "statusCode": status_code,
        "headers":    {"Content-Type": "application/json"},
        "body":       json.dumps(response_body, indent=2),
    }
