# Output Manifest

`members.json` is the extractor's canonical output summary. It records movie-wide metadata, extraction stats, and one entry per retained cast member.

## Top-Level Shape

The file currently looks like:

```json
{
  "movie": {},
  "castLibs": [],
  "stats": {},
  "members": []
}
```

Related sidecar files may also be written:

- `movie.json`
- `timeline.json`
- `castlibs.json`
- `<input>_extraction.log`

## Common Member Fields

Each entry in `members` can include:

- `id`
- `name`
- `type`
- `typeId`
- `outcome`
- `checksum`
- `format`
- `image`
- `paletteFile`
- `scriptFile`

Artifact-reference fields are stored as filenames relative to the output directory.

`outcome` is the member's last extraction result, not just a status flag. It lets the manifest distinguish between successful artifact writes, incremental skips, placeholder-only sources, unresolved references, and unsupported payloads.

## Type-Specific Fields

Examples of additional per-type fields:

- bitmaps: `width`, `height`, `regPoint`, `bitDepth`, `paletteId`, `clutCastLib`
- scripts: `scriptType`
- shapes: `rect`, `pattern`, `foreColor`, `backColor`, `lineSize`
- text/fields: text/style metadata when available

Null members with no useful name are filtered before the final manifest is written.

## Stats Semantics

The `stats` object now separates discovery from the current extraction run.

Each primary bucket has this shape:

```json
{
  "total": 0,
  "byType": {}
}
```

The buckets are:

- `discovered`: final retained manifest members after cleanup/filtering
- `selected`: members that entered the worker queue for the current run
- `extracted`: selected members that produced an output artifact this run
- `skipped`: selected members that did not produce a new artifact this run
- `missing_source`: selected members skipped because their backing chunk was missing, zero-length placeholder-only, or unreadable
- `unresolved_reference`: subset of `missing_source` where the referenced chunk id could not be resolved
- `placeholder_source`: subset of `missing_source` where the member only pointed at zero-length placeholder chunks
- `unchanged`: selected members skipped because the stored checksum matched and `--force` was not used
- `no_output`: selected members that were processed but intentionally produced no artifact
- `empty_asset`: subset of `no_output` for dummy or intentionally empty members
- `unsupported_content`: subset of `no_output` for members with data that the current extractor cannot turn into a supported artifact
- `failed`: selected members that raised a worker error

`selected.total` should equal `extracted.total + skipped.total + failed.total`.

For compatibility, the manifest also keeps:

- `total`: alias of `discovered.total`
- `byType`: alias of `discovered.byType`

`outcome` records the last extraction result for each member, for example `extracted`, `unchanged`, `unresolved_reference`, `placeholder_source`, `empty_asset`, or `unsupported_content`.

Generic binary outputs are still considered `extracted`. For example, an unknown member type that writes a `.bin` file should appear under `extracted`, not `no_output`.

## Log Behavior

`<input>_extraction.log` is written from the same run state that feeds `members.json`, but it is intentionally less noisy in normal mode:

- repeated routine skips such as `placeholder_source` are summarized at the end of the run
- progress is logged at coarse milestones
- worker `DEBUG` traces are only written when `--verbose` is enabled

Warnings and errors for real extraction problems are still written individually.

## Incremental Runs

If `members.json` already exists and `--force` is not used:

1. the previous manifest is loaded
2. worker tasks compare the current content checksum with the stored checksum
3. unchanged members are reported as `SKIP`
4. previous artifact metadata is restored into the new manifest

This keeps `image`, `paletteFile`, `scriptFile`, `width`, `height`, and `format` stable across reruns when the source content has not changed.
