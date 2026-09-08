#!/usr/bin/env bash
# 本地发布：先把 tag 和 Release 建好，再让 electron-builder 往里传产物。
# 顺序很重要——electron-builder 对 dmg / zip 两个 target 是并行发布的，
# 如果 Release 还不存在，两个 publisher 会各建一个，同一个 tag 就会出现两个 Release，
# 而 /releases/latest 可能正好返回那个没有安装包的空壳。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
REPO=$(node -p "require('./package.json').build.publish[0].owner + '/' + require('./package.json').build.publish[0].repo")

git rev-parse "$TAG" >/dev/null 2>&1 || { echo "❌ 本地没有 tag $TAG，先跑 npm version <patch|minor|major>"; exit 1; }
echo "▸ 推送 tag $TAG"
git push origin "$TAG" 2>&1 | tail -1 || true

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "▸ Release $TAG 已存在，直接上传产物"
else
    echo "▸ 创建 Release $TAG"
    gh release create "$TAG" --repo "$REPO" --verify-tag --title "$TAG" --generate-notes
fi

echo "▸ 打包并上传"
CSC_IDENTITY_AUTO_DISCOVERY=false GH_TOKEN=$(gh auth token) npx electron-builder --mac --publish always

COUNT=$(gh api "repos/${REPO}/releases" --jq "[.[] | select(.tag_name == \"${TAG}\")] | length")
if [ "$COUNT" != "1" ]; then
    echo "⚠️  tag $TAG 下有 $COUNT 个 Release，去 https://github.com/${REPO}/releases 清理掉多余的"
    exit 1
fi
echo "✅ 发布完成：https://github.com/${REPO}/releases/tag/${TAG}"
