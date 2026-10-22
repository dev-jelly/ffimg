#!/usr/bin/env bash
set -Eeuo pipefail
: "${CI_PUBLISH_TOKEN:?CI_PUBLISH_TOKEN is required}"
: "${SITE_DIRECTORY:?SITE_DIRECTORY is required}"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$GITHUB_REPOSITORY" =~ ^dev-jelly/(asm|tinytipy|ffimg)$ ]]
test "$GITHUB_REF" = refs/heads/main
test -d "$SITE_DIRECTORY"
site=$(realpath "$SITE_DIRECTORY")
remote="https://github.com/$GITHUB_REPOSITORY.git"
helper='!f() { printf "username=x-access-token\npassword=%s\n" "$CI_PUBLISH_TOKEN"; }; f'
git_auth() { git -c credential.helper="$helper" "$@"; }

# Never publish an older build over a newer source revision.
current=$(git_auth ls-remote "$remote" refs/heads/main | cut -f1)
if [[ "$current" != "$GITHUB_SHA" ]]; then
  echo 'Source main advanced during this build; the newer build owns deployment.'
  exit 0
fi

artifact_repo=$(mktemp -d "$RUNNER_TEMP/pages.XXXXXX")
trap 'rm -rf "$artifact_repo"' EXIT
git init -q "$artifact_repo"
cd "$artifact_repo"
git remote add origin "$remote"
if git_auth ls-remote --exit-code origin refs/heads/gitea-pages >/dev/null 2>&1; then
  git_auth fetch --depth 1 origin gitea-pages
  git checkout -q -b gitea-pages FETCH_HEAD
  test "$(cat .gitea-pages-owner)" = "$GITHUB_REPOSITORY"
else
  git checkout -q --orphan gitea-pages
  printf '%s\n' "$GITHUB_REPOSITORY" > .gitea-pages-owner
fi
mkdir -p site
rsync -a --delete "$site/" site/
printf '%s\n' "$GITHUB_SHA" > source-revision.txt
git config user.name 'Gitea Pages Builder'
git config user.email 'gitea-actions@2msi.org'
git add -- site .gitea-pages-owner source-revision.txt
if ! git diff --cached --quiet; then
  git commit -qm "Build Pages from $GITHUB_SHA"
  git_auth push origin HEAD:refs/heads/gitea-pages
fi
export PAGES_ARTIFACT_SHA
PAGES_ARTIFACT_SHA=$(git rev-parse HEAD)
python3 - <<'PY'
import json, os, urllib.request
payload = {'event_type': 'gitea-pages', 'client_payload': {
    'source_sha': os.environ['GITHUB_SHA'],
    'artifact_sha': os.environ['PAGES_ARTIFACT_SHA'],
}}
request = urllib.request.Request(
    'https://api.github.com/repos/'+os.environ['GITHUB_REPOSITORY']+'/dispatches',
    method='POST', data=json.dumps(payload).encode(), headers={
        'Authorization': 'Bearer '+os.environ['CI_PUBLISH_TOKEN'],
        'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
    })
with urllib.request.urlopen(request, timeout=30) as response:
    if response.status != 204:
        raise SystemExit('GitHub Pages handoff was rejected')
print('GitHub Pages publication requested for verified source '+os.environ['GITHUB_SHA'])
PY
