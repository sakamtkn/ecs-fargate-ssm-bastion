#!/bin/bash

# ECS Fargateタスクに対してSSMポートフォワーディングを実行するスクリプト

set -e

# 設定
CLUSTER_NAME="bastion-cluster"
SERVICE_NAME="bastion-service"
REMOTE_HOST=""
REMOTE_PORT=""
LOCAL_PORT=""

# 使用方法を表示
usage() {
    echo "Usage: $0 -h <remote_host> -r <remote_port> -l <local_port>"
    echo "  -h: Remote host (e.g., RDS endpoint)"
    echo "  -r: Remote port (e.g., 3306 for MySQL)"
    echo "  -l: Local port (e.g., 3306)"
    echo ""
    echo "Example:"
    echo "  $0 -h mydb.cluster-xxx.ap-northeast-1.rds.amazonaws.com -r 3306 -l 3306"
    exit 1
}

# オプション解析
while getopts "h:r:l:" opt; do
    case $opt in
        h) REMOTE_HOST="$OPTARG" ;;
        r) REMOTE_PORT="$OPTARG" ;;
        l) LOCAL_PORT="$OPTARG" ;;
        *) usage ;;
    esac
done

# 必須パラメータチェック
if [[ -z "$REMOTE_HOST" || -z "$REMOTE_PORT" || -z "$LOCAL_PORT" ]]; then
    echo "Error: All parameters are required"
    usage
fi

echo "Setting up port forwarding..."
echo "Remote: $REMOTE_HOST:$REMOTE_PORT"
echo "Local: localhost:$LOCAL_PORT"

# 実行中のタスクを取得
echo "Getting running task..."
TASK_ARN=$(aws ecs list-tasks \
    --cluster "$CLUSTER_NAME" \
    --service-name "$SERVICE_NAME" \
    --desired-status RUNNING \
    --query 'taskArns[0]' \
    --output text)

if [[ "$TASK_ARN" == "None" || -z "$TASK_ARN" ]]; then
    echo "Error: No running tasks found for service $SERVICE_NAME in cluster $CLUSTER_NAME"
    exit 1
fi

# タスクIDを抽出
TASK_ID=$(echo "$TASK_ARN" | cut -d'/' -f3)
echo "Task ID: $TASK_ID"

# タスクの詳細情報を取得してランタイムIDを取得
echo "Getting runtime ID..."
RUNTIME_ID=$(aws ecs describe-tasks \
    --cluster "$CLUSTER_NAME" \
    --tasks "$TASK_ARN" \
    --query 'tasks[0].containers[0].runtimeId' \
    --output text)

if [[ -z "$RUNTIME_ID" || "$RUNTIME_ID" == "None" ]]; then
    echo "Error: Could not get runtime ID"
    exit 1
fi

echo "Runtime ID: $RUNTIME_ID"

# SSMターゲットIDを構築
SSM_TARGET="ecs:${CLUSTER_NAME}_${TASK_ID}_${RUNTIME_ID}"
echo "SSM Target: $SSM_TARGET"

# ポートフォワーディング実行
echo "Starting port forwarding session..."
echo "Press Ctrl+C to stop"

aws ssm start-session \
    --target "$SSM_TARGET" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"$REMOTE_HOST\"],\"portNumber\":[\"$REMOTE_PORT\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"