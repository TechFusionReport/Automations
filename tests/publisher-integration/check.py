#!/usr/bin/env python3
"""Isolated publisher-to-Website contract check. No network or production credentials."""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import html5lib

BASE = "https://www.techfusionreport.com"
ALLOWED = {
    "posts.json", "sitemap.xml", "index.html", "blog.html",
    "technology.html", "entertainment.html", "ai.html",
    "_posts/2026-10-27-integration-ai-guide.html",
    "_posts/2026-10-26-integration-entertainment-guide.html",
}


def run(*args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(f"{args} failed:\n{result.stdout}\n{result.stderr}")
    return result.stdout


def scripts(root, write=True):
    for script in ("rebuild_posts_index.py", "render_post_listings.py", "generate_sitemap.py"):
        args = [sys.executable, "scripts/" + script, "--root", str(root)]
        if not write:
            args.append("--check")
        run(*args, cwd=root)


def fingerprint(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file() and ".git" not in p.parts}


def validate(root):
    fixtures = json.loads((root / ".publisher-fixture-expectations.json").read_text())
    index = json.loads((root / "posts.json").read_text())
    urls = {loc.text for loc in ET.parse(root / "sitemap.xml").findall(
        ".//{http://www.sitemaps.org/schemas/sitemap/0.9}loc")}
    for expected in fixtures:
        filename = expected["filename"]
        relative = "/_posts/" + filename
        html = (root / "_posts" / filename).read_text()
        assert not re.search(r"\{\{[^}]+\}\}", html), filename + ": unresolved template placeholder"
        parser = html5lib.HTMLParser(strict=False)
        parser.parse(html)
        assert not parser.errors, f"{filename}: HTML5 validation errors: {[(error, html.splitlines()[error[0][0]-1]) for error in parser.errors[:5]]}"
        assert "<script>alert(1)</script>" not in html, filename + ": raw script injected"
        if expected["subcategory"]:
            assert "<strong>HTML</strong>" in html, filename + ": production HTML branch not exercised"
            for forbidden in ('onerror=', 'javascript:', '<iframe', '<svg', 'onload='):
                assert forbidden not in html.lower(), filename + ": unsafe HTML remained: " + forbidden
        assert expected["sitemapUrl"] in urls, filename + ": missing expected sitemap URL"
        assert f'href="{expected["sitemapUrl"]}"' in html, filename + ": incorrect canonical"
        assert relative.endswith(expected["slug"] + ".html")
        post = next((item for item in index if item.get("file") == filename), None)
        assert post, filename + ": missing posts.json record"
        for key in ("title", "category", "subcategory"):
            assert post.get(key, "") == expected[key], f"{filename}: wrong {key}: {post.get(key)}"
        assert post["url"] == relative, filename + ": incorrect index URL"
        assert bool(post.get("image")) == bool(expected["image"]), filename + ": image mismatch"
        assert "/_posts/" + expected["related"] in html, filename + ": missing reciprocal related link"
        for page in {"index.html", "blog.html", expected["listing"], expected["categoryListing"]}:
            listing = (root / page).read_text()
            assert relative in listing, filename + ": absent from " + page
        if expected["subcategory"]:
            assert expected["subcategory"] == "AI Tools", "Fixture subcategory unexpectedly changed"
        else:
            assert not post.get("subcategory"), filename + ": unexpected subcategory"
    print("HTML5, explicit metadata, listings, related links, and sitemap assertions passed")


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: check.py <automations-checkout> <website-checkout>")
    automations = Path(sys.argv[1]).resolve()
    website = Path(sys.argv[2]).resolve()
    with tempfile.TemporaryDirectory(prefix="tfr-publisher-") as temporary:
        root = Path(temporary) / "website"
        shutil.copytree(website, root, ignore=shutil.ignore_patterns(".git"))
        # Normalize any pre-existing generated Website drift BEFORE capturing the baseline.
        scripts(root)
        run("git", "init", "-q", cwd=root)
        run("git", "add", "-A", cwd=root)
        run("git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "commit", "-qm", "Isolated generated Website baseline", cwd=root)
        run("node", str(automations / "tests/publisher-integration/fixtures.mjs"), str(root))
        scripts(root, write=False)
        scripts(root)
        validate(root)
        first = fingerprint(root)
        scripts(root)
        scripts(root, write=False)
        assert fingerprint(root) == first, "Website generators are not idempotent"
        # git diff does not include untracked files; inspect both.
        changed = set(run("git", "diff", "--name-only", "HEAD", cwd=root).splitlines())
        changed.update(run("git", "ls-files", "--others", "--exclude-standard", cwd=root).splitlines())
        changed.discard(".publisher-fixture-expectations.json")
        unexpected = changed - ALLOWED
        assert not unexpected, f"Unexpected Website changes: {sorted(unexpected)}"
        assert {"posts.json", "sitemap.xml"}.issubset(changed), "Expected index/sitemap changes missing"
        print("Allowlist, script --check, and second-run idempotency passed")
        print("Publisher integration PASSED")


if __name__ == "__main__":
    main()
