/**
 * One-off: create `supabase/config.staging.toml` from `supabase/config.toml`.
 *
 * Swaps the `project_id` value and prepends a banner explaining that the Supabase
 * CLI does not read this file. Everything else is byte-identical, so the two
 * files cannot drift except at the one line that must differ.
 *
 * Run once. Kept out of `verify:`, so it never runs as part of `verify:db`.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const STAGING_REF = 'xnhsuifcbplnwtxnpedw';
const src = 'supabase/config.toml';
const dst = 'supabase/config.staging.toml';

const original = readFileSync(src, 'utf8');

const before = original;
const after = original.replace(
  /^project_id = "[a-z]{20}"$/m,
  `project_id = "${STAGING_REF}"`,
);
if (after === before) {
  throw new Error('project_id line not matched - refusing to write');
}

const header = `# ================================================== STAGING configuration
#
# ## READ THIS FIRST: the Supabase CLI does NOT read this file.
#
# Verified against supabase CLI v2.119.0:
#
#   $ supabase --config supabase/config.staging.toml projects list
#   Unrecognized flag: --config in command supabase
#     Hint: --config is available on \`supabase postgres-config update\` and
#     \`supabase postgres-config delete\`. Pass it after the subcommand.
#
# There is no \`--config\` on \`db push\` or \`link\`. The CLI always reads
# \`supabase/config.toml\`, and the authoritative link lives in
# \`supabase/.temp/project-ref\` - which points at the STAGING project.
#
# So this file is a **record**, not a switch. It exists so the staging project ref
# is written down somewhere reviewable and diffable, and so that building a
# dedicated staging workdir later is a copy rather than a re-derivation.
#
# ## Why the CLI link points at staging
#
# The link is shared state, so it cannot be right for a staging push and a
# production push at the same time. It points at staging because that is the
# safer of the two mistakes: a bare \`supabase db push\` aimed at staging is
# recoverable, and one aimed at production is not. Isolation still comes from
# passing the target EXPLICITLY:
#
#   supabase --workdir . db push --db-url "<staging session pooler uri>" --skip-vault
#
# \`--db-url\` ignores the link entirely. \`scripts/verify-staging-target.mjs\`
# fails unless the recorded link equals the staging ref. See
# docs/STAGING-VALIDATION.md.
#
# ## To make this file live
#
# Copy the whole supabase/ tree to a separate workdir root and put this file at
# \`<workdir>/supabase/config.toml\`, then always pass \`--workdir <workdir>\`:
#
#   New-Item -ItemType Directory staging/supabase
#   Copy-Item supabase/config.staging.toml staging/supabase/config.toml
#   Copy-Item supabase/migrations staging/supabase/migrations -Recurse
#   supabase --workdir staging link --project-ref <STAGING_REF> -p <password>
#   supabase --workdir staging db push --dry-run
#
# Copying migrations is the price of a separate workdir: it can drift. Prefer
# \`--db-url\` while the project has one workdir.
#
# Everything below this banner is \`supabase/config.toml\` byte-for-byte, with the
# single project_id line changed.

`;

writeFileSync(dst, header + after, 'utf8');
console.log('wrote', dst);