"""Export an explicitly marked static preview computed from REAL local VGP inputs."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from browser_server import HERE, Query, Store

REQUEST: dict[str, Any] = {
    "mode": "anchor", "dataset": "cmaes",
    "windows": [{"accession": "GCA_008658365.1", "seq": "GCA_008658365.1#0#CM018077.1",
                 "start": 164762841, "end": 164785333}],
    "targets": ["GCA_009764595.1", "GCA_009769465.1"],
    "min_identity": 0, "min_length": 0, "direction": "preferred",
}


def relative_sources(value: Any, root: Path) -> Any:
    """Keep source identity but express project files relative to the data root."""
    if isinstance(value, dict):
        return {k: relative_sources(v, root) for k, v in value.items()}
    if isinstance(value, list):
        return [relative_sources(v, root) for v in value]
    if isinstance(value, str) and value.startswith(str(root.resolve()) + "/"):
        return str(Path(value).relative_to(root.resolve()))
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=HERE.parent)
    parser.add_argument("--site-root", type=Path, default=HERE)
    parser.add_argument("--cache", type=Path, default=HERE / ".browser-cache")
    parser.add_argument("--impg", type=Path, default=Path("/scratch/10779/shuocao2374/tool/impg/target/system/release/impg"))
    args = parser.parse_args()
    store = Store(args.data_root, args.cache, args.impg, args.site_root / "heatmap_data.json")
    result = relative_sources(store.query(Query.model_validate(REQUEST)), args.data_root)
    if result["total_blocks"] != 6 or len(result["windows"]) != 3:
        raise RuntimeError("REAL preview validation failed: expected 6 blocks across 3 windows")
    if not all(w["annotation"]["status"] == "available" for w in result["windows"]):
        raise RuntimeError("REAL preview validation failed: annotation unavailable")
    result.update(site_mode="precomputed_real_data_preview", source_path_basis="relative to the VGP data root",
                  custom_queries_available=False)
    out = args.site_root / "browser-data"
    (out / "contigs").mkdir(parents=True, exist_ok=True)
    (out / "preview.json").write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    catalog = {"samples": list(store.catalog.values()), "datasets": ["raw", "filter", "cmaes", "cmaes_sc"],
               "coordinate_system": "0-based half-open", "site_mode": "precomputed_real_data_preview"}
    (out / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n")
    for w in result["windows"]:
        acc = w["accession"]
        data = {"accession": acc, "contigs": [{"seq": s, "length": n} for s, n in
                sorted(store.contigs(acc).items(), key=lambda pair: -pair[1])]}
        (out / "contigs" / f"{acc}.json").write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"REAL preview exported: {result['total_blocks']} blocks / {len(result['windows'])} windows; "
          f"features per window: {[w['annotation']['total'] for w in result['windows']]}")


if __name__ == "__main__":
    main()
