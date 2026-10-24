# Releasing

## Checklist

1. `node --test` → all tests pass.
2. `npm pack --dry-run` → confirm contents:
   - `lib/*.js`, `cordis.patch.yml`, `README.md`, `LICENSE`, `package.json`;
   - no tests/examples/local paths.
3. Confirm `package.json` metadata:
   - `repository`, `homepage`, `bugs`, `author` point to the real repo;
   - `version` bumped (semver);
   - `engines.dsh` matches the supported DSH range.
4. `npm publish --access public`.
5. Tag the release and write release notes (privacy/cost defaults changes are user-visible).

## Post-publish smoke (clean profile)

1. Create a fresh DSH profile (or use a temp `DSH_HOME`).
2. Add `dsh-experience-skill` to dependencies and `dsh.profile.bundles`.
3. `pnpm install`, restart DSH.
4. Verify:
   - Skill List has exactly one new entry `experience-retrieval`;
   - `experience_search` returns `NO_MATCH` on an empty library;
   - `$DSH_HOME/experience-skill/` is created;
   - a second window is read-only (lock owner).
5. Delete the profile and data dir after smoke.

## Privacy check before release

- Default `autoLearn: true` means a batch call may be sent after ~8 turns. Announce this in release notes.
- `$DSH_HOME/experience-skill/` contains local traces; tell users how to delete it.
- Do not include local install paths, tokens, or screenshots in the repo.
