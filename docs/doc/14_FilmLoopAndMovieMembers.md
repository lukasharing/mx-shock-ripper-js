# FilmLoop and Movie Members

This page covers FilmLoop members (Type 2) and Movie members (Type 9).

## FilmLoop Extraction

FilmLoops are handled by `MovieExtractor`.

- current output suffix: `.filmloop.json`
- current payload model: score-like timeline data embedded in the member payload
- current export goal: analysis-friendly JSON, not Director replay fidelity

There is no dedicated `--filmloop` CLI flag today. When FilmLoop members are discovered by the main extractor pass, they are processed as part of the standard worker pipeline.

## FilmLoop Parse Model

The extractor reads:

1. member flags
2. bounds rectangle
3. cast flags
4. the remaining payload as score/frame data

The remaining stream is interpreted as a delta-compressed timeline:

- a frame may contain only changes from the previous frame
- the parser reconstructs the current frame state incrementally
- each decoded channel currently captures a small common subset of properties

The JSON output includes:

- `memberId`
- `name`
- `flags`
- `bounds`
- `castFlags`
- `frameCount`
- `frames`

## Movie Members

Movie members also use `MovieSpec` for basic metadata parsing:

- `_castFlags`
- `rect`

There is not yet a dedicated high-level exporter for Type 9 Movie members. In practice they are currently limited to manifest metadata, or generic binary preservation if a usable payload is surfaced by the worker.

## Current Limitations

- FilmLoop score parsing is heuristic and intentionally narrow.
- Only a small subset of channel properties is reconstructed today.
- The exported JSON is useful for inspection, not for lossless Director timeline restoration.
- Type 9 Movie members do not yet have a specialized writer comparable to `movie.json` / `timeline.json` extraction at the project level.
