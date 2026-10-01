---
"@e2e-dev/github": patch
---

Two matrix jobs whose `key`, workflow, or job differ only after the first 200 encoded characters now keep their own pull request comments instead of overwriting one. A long field's marker ends in a digest of the whole value; markers of shorter fields are unchanged, so existing comments are still found. A job with a field that long posts one new comment after upgrading and leaves its old one behind. The reporter only takes a comment whose first line is its marker, so a reply quoting the marker is never edited.
