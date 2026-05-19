#!/usr/bin/env python3
"""
GitHub Issue → Kanban 同步脚本
每60分钟执行一次，自动将新 Issue 转为 kanban 任务。
"""
import subprocess, json, os, sys, re

GH_REPO = "fldddd/LinguaCaption"
KANBAN_BOARD = "linguacaption"

# 获取所有 open issue（排除 #14 是父 Issue 不需要执行任务）
result = subprocess.run(
    ["gh", "issue", "list", "--repo", GH_REPO, "--state", "open",
     "--json", "number,title,labels", "--limit", "50"],
    capture_output=True, text=True, cwd=f"D:/projects/LinguaCaption"
)
if result.returncode != 0:
    print(f"ERROR: gh issue list failed: {result.stderr}")
    sys.exit(1)

issues = json.loads(result.stdout)

# 获取当前 kanban 任务
kresult = subprocess.run(
    ["hermes", "kanban", "--board", KANBAN_BOARD, "list", "--json"],
    capture_output=True, text=True
)

# Parse kanban tasks - get titles
kanban_titles = set()
if kresult.returncode == 0:
    for line in kresult.stdout.split("\n"):
        # Match task title patterns like "#15" in task names
        m = re.search(r'#(\d+)', line)
        if m:
            kanban_titles.add(int(m.group(1)))

# Labels → profile mapping
LABEL_PROFILE = {
    "frontend": "developer",
    "backend": "devops",
    "fullstack": "reviewer",
}
LABEL_PRIORITY = {
    "P0": "P0",
    "P1": "P1",
    "P2": "P2",
}

# 父 Issue（不创建任务）
PARENT_ISSUES = {14, 22}

new_issues = []
for issue in issues:
    n = issue["number"]
    if n in kanban_titles or n in PARENT_ISSUES:
        continue
    
    labels = [l["name"] for l in issue["labels"]]
    profile = "developer"  # default
    for l, p in LABEL_PROFILE.items():
        if l in labels:
            profile = p
            break
    
    priority = ""
    for l, p in LABEL_PRIORITY.items():
        if l in labels:
            priority = f"[{p}] "
            break
    
    new_issues.append((n, issue["title"], profile, priority))

if not new_issues:
    print(f"✅ 无新 Issue，看板已同步 ({len(issues)} open issues)")
    sys.exit(0)

# Create kanban tasks for new issues
created = []
for n, title, profile, priority in new_issues:
    cmd = [
        "hermes", "kanban", "--board", KANBAN_BOARD, "create",
        f"{priority}{title} (#{n})",
        "--assignee", profile,
        "--body", f"GitHub Issue #{n}: {title}"
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0:
        print(f"✅ Created kanban task for #{n} ({profile})")
        created.append(f"#{n}")
    else:
        print(f"❌ Failed to create task for #{n}: {r.stderr[:100]}")

print(f"\n📊 同步完成：新增 {len(created)} 个任务，现有 {len(issues)} 个 open issue")
