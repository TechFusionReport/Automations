#!/bin/bash
set -e
rm -rf dist
mkdir -p dist

# Root web files
for f in *.html *.css *.json CNAME .nojekyll; do
  [ -f "$f" ] && cp "$f" dist/ || true
done

# Subdirectories with web content
cp -r graphics dist/
[ -d "_posts" ] && cp -r _posts dist/ || true
[ -d "ops" ] && cp -r ops dist/ || true
