#!/usr/bin/env bash
#
# 手元でビルドした `dist/` を GitHub Pages 用の `gh-pages` ブランチへ公開する。
#
# GitHub Actions でビルドしない理由: 本リポジトリはエンジンを Git 管理外の
# `reference/console-chaos-engine-0.2.0.tgz` から `file:` で参照している
# （README「セットアップ」）。クローンしただけの環境では `npm install` が通らず、
# エンジンの `main` からビルドし直すと中身が動作確認したものとずれる。
# 「手元で確かめた現物」をそのまま配るほうが再現性が高い。
#
# 使い方:
#   npm run build
#   npm run deploy:pages          # 既定のリモート origin へ push
#   npm run deploy:pages -- upstream
#
set -euo pipefail

branch="gh-pages"
remote="${1:-origin}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [ ! -f dist/index.html ]; then
  echo "dist/index.html がない。先に 'npm run build' を実行する。" >&2
  exit 1
fi

source_commit="$(git rev-parse --short HEAD)"
work="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$work" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# 既に公開済みなら履歴を継ぎ、初回なら orphan ブランチから始める。
git fetch --quiet "$remote" "$branch" 2>/dev/null || true
if git rev-parse --verify --quiet "refs/remotes/$remote/$branch" >/dev/null; then
  git worktree add --quiet --detach "$work" "$remote/$branch"
  git -C "$work" checkout --quiet -B "$branch" "$remote/$branch"
else
  git worktree add --quiet --detach "$work" HEAD
  git -C "$work" checkout --quiet --orphan "$branch"
  git -C "$work" rm -rq --cached . >/dev/null 2>&1 || true
fi

# 作業ツリーを空にしてから dist をまるごと置く（消えた資産も追随させる）。
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R dist/. "$work"/
# Jekyll に触らせない（`_` 始まりのファイルが落とされるのを防ぐ）。
touch "$work/.nojekyll"

git -C "$work" add -A
if git -C "$work" diff --cached --quiet; then
  echo "公開済みの内容と同じだった。push は行わない。"
  exit 0
fi
git -C "$work" commit --quiet -m "Deploy dist from ${source_commit}"
git -C "$work" push --quiet "$remote" "$branch"
echo "gh-pages を更新した（元コミット ${source_commit}）。"
