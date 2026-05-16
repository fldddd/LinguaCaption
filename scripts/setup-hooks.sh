#!/usr/bin/env bash
# ====================================================================
# 安装 LinguaCaption Git Hooks
# 每个开发者 clone 后运行一次：
#   bash scripts/setup-hooks.sh
# 这会在 .git/hooks 中安装 post-commit / post-merge 等 hooks，
# 确保每次 commit 后自动输出完整 commit message。
# ====================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_SOURCE="$PROJECT_DIR/.githooks"
HOOK_TARGET="$PROJECT_DIR/.git/hooks"

echo "📦 安装 LinguaCaption Git Hooks..."
echo "   源: $HOOK_SOURCE"
echo "   目标: $HOOK_TARGET"

# 方式 A: 使用 core.hooksPath (推荐，hooks 和 repo 一起版本控制)
echo ""
echo "选项 1: core.hooksPath (推荐)"
echo "   git config core.hooksPath .githooks"
echo "   这样 hooks 直接跑 .githooks/ 目录，随版本控制更新。"
echo ""
echo "选项 2: 复制到 .git/hooks/"
echo "   cp .githooks/* .git/hooks/"
echo "   传统方式，hooks 不 track 但更兼容。"
echo ""

# 检测是否已配置
CURRENT="$(git config core.hooksPath 2>/dev/null || echo '')"
if [ "$CURRENT" = ".githooks" ]; then
    echo "✅ 已通过 core.hooksPath 配置 (当前值: $CURRENT)"
else
    echo "🔄 配置 core.hooksPath..."
    git config core.hooksPath .githooks
    echo "✅ 已设置 core.hooksPath = .githooks"
fi

# 检查 hooks 是否可执行
echo ""
echo "🔍 验证 hooks..."
for hook in "$HOOK_SOURCE"/*; do
    name="$(basename "$hook")"
    if [ -x "$hook" ]; then
        echo "   ✅ $name (可执行)"
    else
        echo "   ⚠️  $name (不可执行, chmod +x)"
        chmod +x "$hook"
        echo "   ✅ $name (已修复)"
    fi
done

echo ""
echo "🎉 Git Hooks 安装完成!"
echo "   每次 git commit / git merge 后会自动显示完整 commit message。"
