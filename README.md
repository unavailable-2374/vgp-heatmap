# VGP pairwise heatmap viewer

Interactive web heatmaps of all-vs-all genome alignments for **581 VGP genomes**.

**Live site:** https://unavailable-2374.github.io/vgp-heatmap/

Two heatmap pages:

* **Similarity** — weighted-Jaccard similarity between each genome pair (symmetric).
* **Coverage** — fraction of genome *i* covered when aligned to genome *j* (directional).

## Method

Computed from 336,980 directional PAF files of all-vs-all alignments. For each
lower-triangle pair (`query_acc < target_acc`):

```
query_frac   = query_covered / query_size           <- coverage (directional)
target_frac  = target_covered / target_size
intersection = sum over alignment blocks of min(target_span, query_span)
union        = query_size + target_size - intersection
jaccard      = intersection / union                 <- weighted-Jaccard similarity
```

This follows the method of <https://github.com/ekg/vgp_heatmap>.

## Files

| file | description |
|------|-------------|
| `index.html` | self-contained viewer (loads the JSON via `fetch()`) |
| `heatmap_data.json` | aggregated similarity + coverage matrices for all 581 genomes |

## Run locally

`index.html` uses `fetch()`, so it must be served over HTTP (not opened as `file://`):

```bash
python3 -m http.server 8765
# then open http://localhost:8765/
```
