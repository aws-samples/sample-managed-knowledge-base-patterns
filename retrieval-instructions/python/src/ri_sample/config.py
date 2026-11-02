"""AWS clients. The Region is AWS_REGION when set, else us-east-1. Creating the clients makes no network call.

Credentials come from the default chain (AWS_PROFILE, environment variables, and so on).
"""

import os

import boto3
from botocore.config import Config

# One stream call can run for a minute or more. Standard retries cover throttling on the initial request.
RUNTIME_CONFIG = Config(read_timeout=120, retries={"mode": "standard", "max_attempts": 5})

region = os.environ.get("AWS_REGION", "us-east-1")
agent = boto3.client("bedrock-agent", region_name=region)  # retrieval instructions
runtime = boto3.client("bedrock-agent-runtime", region_name=region, config=RUNTIME_CONFIG)  # agentic_retrieve_stream
sts = boto3.client("sts", region_name=region)
cloudformation = boto3.client("cloudformation", region_name=region)
cloudtrail = boto3.client("cloudtrail", region_name=region)
