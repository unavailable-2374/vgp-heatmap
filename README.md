# VGP pairwise heatmap viewer

Interactive web heatmaps of all-vs-all genome alignments for **581 VGP genomes**.

**Live site:** https://unavailable-2374.github.io/vgp-heatmap/

The matrix is shown as a **45°-rotated triangle** — the diagonal becomes the
flat top edge, the dendrogram sits above it, and each pair is one diamond cell.
Because every pair is computed from a single PAF, only one triangle is needed
(no redundant mirrored half).

Two heatmap pages:

* **Similarity** — weighted-Jaccard similarity between each genome pair
  (symmetric; one solid diamond per pair).
* **Coverage** — fraction of genome *i* covered when aligned to genome *j*
  (directional; each diamond splits into two triangles, one per direction,
  when zoomed in).

A **Dataset** selector in the header switches which alignment version the
heatmap displays — `raw`, `filter`, `cmaes`, or `cmaes_sc` — so the same
similarity/coverage plates can be compared across pipelines. The selection also
re-points the per-cell and portal download links at that version's bucket
(`cmaes` and `cmaes_sc` are live on GenomeArk; `raw`/`filter` are local-only
intermediates and their per-pair links stay disabled).

## Downloading data

The viewer links straight to the public **GenomeArk** bucket
(`s3://genomeark/working/staging/all_vs_all_alignments/FastGA/cmaes/`), where each
ordered pair is stored as `{query_accession}_vs_{target_accession}.paf.gz`
(RefSeq GCF when available, otherwise GenBank GCA; 581 × 580 = 336,980
directional files).

The **Data portal** provides three workflows:

* **Pairwise alignments** — search for two species or GCA/GCF accessions directly,
  then choose `raw`, `filter`, `cmaes`, or `cmaes_sc`. Each direction exposes the
  matching `.paf.gz`, `.cov`, and `.id` artifact slots. The `cmaes` and `cmaes_sc`
  PAF links are enabled against GenomeArk; `raw`/`filter` and the COV/ID files
  remain visibly pending until their S3 locations are uploaded/configured.
* **Genome files** — search the assembly catalogue for GFF annotations and
  reference FASTA files. Their accession mappings are present; download buttons
  remain in an explicit “S3 pending” state until the public base URLs are added.
* **Bulk & CLI** — export a manifest for a `Shift`-drag heatmap selection, or
  copy `aws s3 sync` / `s5cmd` commands for the complete PAF collection
  (`--no-sign-request`; the set is ~1.5 TB).

No AWS account is needed (public bucket). The upload is still in progress, so a
few pairs may 404; every generated command skips missing files and is safe to
re-run — `aws s3 sync` picks up newly added pairs each time.

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
| `index.html` | heatmap viewer and data-portal markup |
| `heatmap_data.json` | aggregated similarity + coverage matrices for all 581 genomes |
| `downloads.css` | data-portal layout and responsive styling |
| `downloads.js` | pair lookup, resource search/filtering, and bulk manifests |
| `download_catalog.json` | PAF/GFF/FA accession and file mapping; S3 base URLs are configured here |

## Run locally

`index.html` uses `fetch()`, so it must be served over HTTP (not opened as `file://`):

```bash
python3 -m http.server 8765
# then open http://localhost:8765/
```
