# Public version tag policy

Pi Jev Helm distributes its Public Preview exclusively through immutable Git version tags (see [ADR 0001](adr/0001-release-public-preview-from-git-tags.md)). Once a `v*` tag is pushed and published, the exact source it names is part of the product's identity: every install command that references the tag must keep resolving to the same source forever.

## Immutability policy

- A public `v*` tag is created once and never updated, moved, or deleted.
- If a published tag is defective, it is retained and superseded by a new patch tag (for example, `v0.1.0` is followed by `v0.1.1`); the original tag is never moved to different source.
- Patch releases within one minor line preserve the user-facing configuration schema and `/helm` command grammar, so superseding a failed tag never silently changes user-visible behavior.

## GitHub ruleset

The policy is enforced by a repository ruleset configured through the GitHub REST API. It is recorded here because repository settings leave no trace inside the repository. Current configuration (`GET /repos/Z761293629/pi-jev-helm/rulesets`):

- **Name:** `Immutable public version tags`
- **Target:** `tag`
- **Enforcement:** `active`
- **Conditions:** ref name matches `refs/tags/v*` (no exclusions)
- **Rules:** `update` and `deletion`
- **Bypass actors:** none — no role can bypass the ruleset

Creating a matching tag is not restricted, so the first push of a new version tag succeeds. With the tag in place, both update and deletion are blocked for everyone, including administrators. There is no repo-level escape hatch by design: correcting a release means publishing a new patch tag, never rewriting history behind a version users may have already installed.

If the ruleset must ever be recreated, apply it with:

```sh
gh api -X POST repos/Z761293629/pi-jev-helm/rulesets --input - <<'EOF'
{
  "name": "Immutable public version tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/tags/v*"], "exclude": [] }
  },
  "bypass_actors": [],
  "rules": [
    { "type": "update" },
    { "type": "deletion" }
  ]
}
EOF
```
