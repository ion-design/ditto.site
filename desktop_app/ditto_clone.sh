#!/usr/bin/env bash

set -euo pipefail

echo "=========================================="
echo "       Ditto Website Cloner CLI           "
echo "=========================================="
echo ""

# ------------------------------------------------------------------------------
# 1. API Key Setup (Email is optional)
# ------------------------------------------------------------------------------
read -p "Do you already have a Ditto API key? (y/n) [default: y]: " HAS_KEY
HAS_KEY=${HAS_KEY:-y}

if [[ "$HAS_KEY" =~ ^[Yy]$ ]]; then
    read -p "Enter your Ditto API Key: " API_KEY
    if [ -z "$API_KEY" ]; then
        echo "❌ Error: API Key cannot be empty."
        exit 1
    fi
else
    read -p "Enter your Email to request a key: " USER_EMAIL
    if [ -z "$USER_EMAIL" ]; then
        echo "❌ Error: Email is required when requesting a key."
        exit 1
    fi
    echo "📩 Requesting API key for $USER_EMAIL..."
    curl -sS -X POST "https://api.ditto.site/v1/signup/request" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$USER_EMAIL\"}"
    echo ""
    read -p "Paste your API Key once received: " API_KEY
fi

# ------------------------------------------------------------------------------
# 2. Target Website & Preferences
# ------------------------------------------------------------------------------
echo ""
read -p "Enter Website URL to clone (e.g. https://example.com): " TARGET_URL
if [ -z "$TARGET_URL" ]; then
    echo "❌ Error: Website URL is required."
    exit 1
fi

read -p "Enter Output Folder Name [default: cloned-site]: " FOLDER
FOLDER=${FOLDER:-cloned-site}

read -p "Select Mode (1 for multi, 2 for single) [default: 1]: " MODE_CHOICE
if [ "$MODE_CHOICE" = "2" ]; then
    MODE="single"
else
    MODE="multi"
fi

read -p "Select Framework (1 for next, 2 for vite) [default: 1]: " FW_CHOICE
if [ "$FW_CHOICE" = "2" ]; then
    FRAMEWORK="vite"
else
    FRAMEWORK="next"
fi

echo ""
echo "🚀 Submitting request to clone $TARGET_URL ($MODE mode, $FRAMEWORK framework)..."

# ------------------------------------------------------------------------------
# 3. Submit Clone Job
# ------------------------------------------------------------------------------
RESPONSE=$(curl -sS -X POST "https://api.ditto.site/v1/clones" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"$TARGET_URL\",
    \"options\": {
      \"mode\": \"$MODE\",
      \"framework\": \"$FRAMEWORK\",
      \"styling\": \"tailwind\"
    }
  }")

# Robust JSON extraction for Job ID
JOB_ID=$(echo "$RESPONSE" | grep -o '"jobId"[[:space:]]*:[[:space:]]*"[^"]*' | cut -d'"' -f4 || true)
if [ -z "$JOB_ID" ]; then
    JOB_ID=$(echo "$RESPONSE" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*' | cut -d'"' -f4 || true)
fi

if [ -z "$JOB_ID" ]; then
    echo "❌ Failed to create clone job. Server response:"
    echo "$RESPONSE"
    exit 1
fi

echo "✅ Job Created! ID: $JOB_ID"
echo "⏳ Waiting for Ditto servers to process and build components..."

# ------------------------------------------------------------------------------
# 4. Poll Job Status
# ------------------------------------------------------------------------------
while true; do
    STATUS_RESPONSE=$(curl -sS -H "Authorization: Bearer $API_KEY" "https://api.ditto.site/v1/clones/$JOB_ID")
    STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*' | cut -d'"' -f4 || echo "running")

    echo "   └─ Status: $STATUS"

    if [ "$STATUS" = "succeeded" ] || [ "$STATUS" = "completed" ]; then
        echo ""
        echo "🎉 Clone finished successfully on server!"
        break
    elif [ "$STATUS" = "failed" ]; then
        echo ""
        echo "❌ Job failed on Ditto's servers."
        echo "Response: $STATUS_RESPONSE"
        exit 1
    fi

    sleep 5
done

# ------------------------------------------------------------------------------
# 5. Download & Extract Archive
# ------------------------------------------------------------------------------
mkdir -p "$FOLDER"

echo ""
echo "📦 Downloading bundle and extracting directly into './$FOLDER'..."

curl -L -sS -H "Authorization: Bearer $API_KEY" \
  "https://api.ditto.site/v1/clones/$JOB_ID/bundle?format=tgz" \
  | tar -xzf - -C "$FOLDER/"

echo ""
echo "=========================================="
echo "✨ All set! Your project is ready."
echo "=========================================="
echo ""
echo "To run your app, execute:"
echo "  cd $FOLDER"
echo "  npm install"
echo "  npm run dev"
echo ""
