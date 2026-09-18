# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root.
- **`CONTEXT-MAP.md`** if it exists; read each linked context relevant to the topic.
- **`docs/adr/`** for decisions touching the area being changed.

If these files don't exist, proceed silently. Domain-modeling skills create them lazily when terms or decisions are resolved.

## File structure

This is a single-context repository:

/
├── CONTEXT.md
├── docs/adr/
└── src/

## Use the glossary's vocabulary

When output names a domain concept, use the term defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If a needed concept is missing, reconsider whether the term belongs or note the gap for the domain-modeling skill.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding.
