#!/usr/bin/env bash
# ====================================================================
# LinguaCaption Git 通知脚本
# 功能: 展示完整 commit message (不只有 headline) + PR merge 信息
# 用法:
#   git-notify.sh --last          # 显示最后一个 commit 完整信息
#   git-notify.sh --range A..B    # 显示某个范围内的 commits
#   git-notify.sh --new           # 显示自上次检查以来的新 commits
#   git-notify.sh --watch         # 初始化 watch 记录
# ====================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WATCH_FILE="$PROJECT_DIR/.git_notify_watch"
LOG_FILE="$PROJECT_DIR/logs/git-notify.log"
BRANCHES_TO_WATCH="develop feat/devops/b6-database feat/developer/frontend-f1-f6 feat/architect/s1-s2-bridge feat/reviewer/b5-vocab-api master"

mkdir -p "$(dirname "$LOG_FILE")"

log_msg() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
    echo "$*"
}

# ── 格式化输出单个 commit 完整信息 ──────────────────────────
format_commit_full() {
    local ref="${1:-HEAD}"
    local sha files_added files_modified files_deleted total_files
    local is_merge="no"

    sha="$(git rev-parse "$ref" 2>/dev/null)" || {
        log_msg "ERROR: 找不到引用 $ref"
        return 1
    }

    # 检测是否为 merge commit
    if [ "$(git rev-list --parents -n 1 "$sha" 2>/dev/null | wc -w)" -gt 2 ]; then
        is_merge="yes"
    fi

    # 文件变更统计
    files_added="$(git diff-tree --no-commit-id -r --diff-filter=A "$sha" 2>/dev/null | wc -l)"
    files_modified="$(git diff-tree --no-commit-id -r --diff-filter=M "$sha" 2>/dev/null | wc -l)"
    files_deleted="$(git diff-tree --no-commit-id -r --diff-filter=D "$sha" 2>/dev/null | wc -l)"
    total_files="$(git diff-tree --no-commit-id -r "$sha" 2>/dev/null | wc -l)"

    echo ""
    echo "┌──────────────────────────────────────────────────────────────┐"
    if [ "$is_merge" = "yes" ]; then
        echo "│  🔀 MERGE COMMIT"
        echo "├──────────────────────────────────────────────────────────────┤"
    else
        echo "│  📦 COMMIT"
        echo "├──────────────────────────────────────────────────────────────┤"
    fi
    echo "│  Commit:  ${sha:0:12}"
    echo "│  Author:  $(git log -1 --format='%an <%ae>' "$sha")"
    echo "│  Date:    $(git log -1 --format='%ai' "$sha")"
    echo "│  Branch:  $(git name-rev --name-only "$sha" 2>/dev/null || echo '?')"

    if [ "$is_merge" = "yes" ]; then
        local parents
        parents="$(git rev-list --parents -n 1 "$sha")"
        #parents="${parents#* }"  # remove sha itself, keep parent list
        echo "│  Parents: $(echo "$parents" | cut -d' ' -f2-)"
    fi

    echo "├──────────────────────────────────────────────────────────────┤"
    echo "│  📝 完整 Commit Message:"
    echo "│"
    # 输出完整 commit message（含 body），每行前加 "│  "
    git log -1 --format='%B' "$sha" | sed 's/^/│  /'
    echo "│"
    echo "├──────────────────────────────────────────────────────────────┤"
    echo "│  📂 变更文件: $total_files total"
    if [ "$files_added" -gt 0 ]; then
        echo "│     ➕ Added:    $files_added"
        git diff-tree --no-commit-id -r --name-only --diff-filter=A "$sha" 2>/dev/null | head -10 | sed 's/^/│     • /'
    fi
    if [ "$files_modified" -gt 0 ]; then
        echo "│     ✏️ Modified:  $files_modified"
        git diff-tree --no-commit-id -r --name-only --diff-filter=M "$sha" 2>/dev/null | head -10 | sed 's/^/│     • /'
    fi
    if [ "$files_deleted" -gt 0 ]; then
        echo "│     ❌ Deleted:   $files_deleted"
        git diff-tree --no-commit-id -r --name-only --diff-filter=D "$sha" 2>/dev/null | head -10 | sed 's/^/│     • /'
    fi
    # 如果文件超过列表阈值
    if [ "$total_files" -gt 10 ]; then
        echo "│     ... (共 $total_files 个文件，仅显示前 10)"
    fi

    # PR merge 信息检测 (GitHub squash merge 格式: #123 from branch)
    local body
    body="$(git log -1 --format='%B' "$sha")"
    if echo "$body" | grep -qE '\(#\d+\)'; then
        local pr_num
        pr_num="$(echo "$body" | grep -oE '#\d+' | head -1)"
        local pr_branch
        pr_branch="$(echo "$body" | grep -oE 'from\s+\S+' | head -1 || true)"
        echo "│"
        echo "│  🔗 PR Merge 信息:"
        echo "│     PR Number:  ${pr_num:-N/A}"
        [ -n "$pr_branch" ] && echo "│     源分支:    ${pr_branch#from }"
    fi

    echo "└──────────────────────────────────────────────────────────────┘"
    echo ""
}

# ── 显示最近 N 个 commits 完整信息 ────────────────────────
show_recent() {
    local count="${1:-5}"
    log_msg "📋 最近 $count 个 commits (完整信息):"
    for i in $(seq 1 "$count"); do
        local ref="HEAD~$((count - i))" 2>/dev/null
        if git rev-parse "HEAD~$((count - i))" >/dev/null 2>&1; then
            format_commit_full "HEAD~$((count - i))"
        fi
    done
    format_commit_full HEAD
}

# ── 显示最后一个 commit ──────────────────────────────────
show_last() {
    log_msg "🔔 新提交 (post-commit hook):"
    format_commit_full HEAD
    log_msg "通知完成: $(git log -1 --format='%h %s' HEAD)"
}

# ── 显示新 commits (自上次检查以来) ──────────────────────
show_new() {
    local last_checked=""
    if [ -f "$WATCH_FILE" ]; then
        last_checked="$(cat "$WATCH_FILE")"
    fi

    local new_commits=""
    if [ -n "$last_checked" ] && git cat-file -e "$last_checked" 2>/dev/null; then
        new_commits="$(git log --oneline "$last_checked..HEAD" 2>/dev/null | tail -1)"
    fi

    if [ -z "$new_commits" ]; then
        log_msg "📭 自上次检查以来无新提交"
        echo "$(git rev-parse HEAD)" > "$WATCH_FILE"
        return 0
    fi

    log_msg "📬 发现新提交 (自 $(git log -1 --format='%h %s' "$last_checked" 2>/dev/null || echo '初始')):"

    local count
    count="$(git rev-list --count "$last_checked..HEAD" 2>/dev/null)"
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  📬 新提交发现! 共 $count 个新 commit                       ║"
    echo "╚══════════════════════════════════════════════════════════════╝"

    for sha in $(git rev-list "$last_checked..HEAD" --reverse 2>/dev/null); do
        format_commit_full "$sha"
    done

    # 更新 watch 记录
    echo "$(git rev-parse HEAD)" > "$WATCH_FILE"
    log_msg "Watch 已更新至: $(git log -1 --format='%h %s' HEAD)"
}

# ── 初始化 watch ─────────────────────────────────────────
init_watch() {
    echo "$(git rev-parse HEAD)" > "$WATCH_FILE"
    log_msg "✅ Watch 初始化完成: $(git log -1 --format='%h %s' HEAD)"
}

# ── 跨分支检查 ───────────────────────────────────────────
check_all_branches() {
    log_msg "🔍 跨分支检查开始..."
    git fetch origin 2>/dev/null || true

    for branch in $BRANCHES_TO_WATCH; do
        if git rev-parse "origin/$branch" >/dev/null 2>&1; then
            local local_sha remote_sha
            local_sha="$(git rev-parse "$branch" 2>/dev/null || echo 'none')"
            remote_sha="$(git rev-parse "origin/$branch")"

            if [ "$local_sha" != "$remote_sha" ]; then
                echo ""
                echo "╔══════════════════════════════════════════════════════════════╗"
                echo "║  🔄 分支更新: $branch"
                echo "╚══════════════════════════════════════════════════════════════╝"

                local count
                if [ "$local_sha" != "none" ]; then
                    count="$(git rev-list --count "$local_sha..origin/$branch" 2>/dev/null)"
                else
                    count="$(git rev-list --count "origin/$branch" 2>/dev/null)"
                fi
                echo "   远端有新提交 ($count 个)"

                for sha in $(git rev-list "origin/$branch" --not --all 2>/dev/null | head -5); do
                    format_commit_full "$sha"
                done
            fi
        fi
    done
}

# ── Main ────────────────────────────────────────────────
cd "$PROJECT_DIR"

case "${1:-}" in
    --last)
        show_last
        ;;
    --range)
        format_commit_full "$2"
        ;;
    --new)
        show_new
        ;;
    --watch)
        check_all_branches
        ;;
    --init)
        init_watch
        ;;
    --recent)
        show_recent "${2:-5}"
        ;;
    *)
        echo "用法: git-notify.sh [选项]"
        echo "  --last         显示最后一个 commit 完整信息"
        echo "  --range SHA..  显示指定 commit 信息"
        echo "  --new          显示自上次检查以来的新 commits"
        echo "  --watch        跨分支检查远端更新"
        echo "  --init         初始化 watch 记录"
        echo "  --recent [N]   显示最近 N 个 commits (默认 5)"
        exit 0
        ;;
esac
