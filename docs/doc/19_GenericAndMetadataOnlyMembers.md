# Generic and Metadata-Only Members

This page covers member types that do not currently have a dedicated high-level extractor.

## Picture (Type 5)

Picture members are identified separately from bitmap members, but there is no specialized Picture decoder yet.

- best case: raw payload is preserved as generic `.bin`
- otherwise: the member remains manifest-only metadata

## Button (Type 7)

`ButtonSpec` currently parses:

- `rect`
- `buttonType`
- `_castFlags`

There is no dedicated exporter for button skins or interaction states. If the worker surfaces a raw payload, it falls back to generic `.bin` preservation.

## RTE (Type 12)

`RTE` is distinct from Text and Field members. There is no dedicated Rich Text Engine parser today.

- current behavior: generic `.bin` preservation when content is available
- otherwise: manifest-only metadata

## Transition (Type 14)

`TransitionSpec` currently parses:

- `_castFlags`
- `duration`
- `chunkSize`
- `transitionType`

There is no renderer or opcode decoder for transition effects yet, so the output path is currently generic `.bin` preservation when data exists.

## Mesh (Type 17)

Mesh members do not yet have a dedicated 3D extractor.

- current behavior: preserve raw payload as `.bin` when possible
- no geometry, material, or animation reconstruction yet

## Unknown and Custom Member Types

This includes known unmapped IDs such as:

- Type 53
- Type 121
- Type 638
- Type 2049

When a raw payload exists, the extractor preserves it as `.bin`. Otherwise the manifest outcome makes it clear whether the member was placeholder-only, unresolved, empty, or unsupported.

## Null and Placeholder Members

Unnamed `Null` placeholders are filtered out of the final manifest. Named or diagnostically useful placeholders may still remain.

## Manifest Outcomes For These Types

The generic/metadata-only path relies on the same explicit outcomes used by the rest of the extractor:

- `extracted`
- `unchanged`
- `placeholder_source`
- `unresolved_reference`
- `empty_asset`
- `unsupported_content`
