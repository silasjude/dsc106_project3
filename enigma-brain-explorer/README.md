# ENIGMA Brain Explorer

An interactive 3D brain that shows how brain structure differs across 11 brain conditions, built from the published summary statistics in the [ENIGMA Toolbox](https://github.com/MICA-MNI/ENIGMA).

Open `index.html` in a browser. It is a single self-contained page; the only things it loads from the web are three.js, three-mesh-bvh and Google Fonts.

## What it shows

- **3D brain:** 68 cortical areas and 16 deep structures (Desikan-Killiany atlas). Blue means thinner or smaller on average in people with the condition, orange means thicker or larger, brighter means a bigger difference, dark grey means no reliable difference.
- **Condition x area matrix:** every condition against every area at once. Hovering a cell previews it on the brain, clicking selects it.
- **Detail panel:** plain-language summary of the hovered area, with two overlapping bell curves (healthy vs condition), a "typical person is thinner than X% of healthy people" sentence, and the raw stats (Cohen's d, CI, p, sample sizes).

Conditions: 22q11.2 deletion syndrome, ADHD, autism, depression, bipolar disorder, schizophrenia, OCD, anorexia nervosa, antisocial behavior, epilepsy (plus left/right temporal lobe and generalized subtypes) and Parkinson's disease.

## Interaction design

Built around the interaction taxonomy from Yi et al. (2007):

| Intent | How it shows up |
|---|---|
| Select | Hover or click any area on the brain or any matrix cell |
| Connect | Brushing and linking between the brain and the matrix |
| Abstract / Elaborate | Docked detail panel (overview + detail) |
| Filter | Click a lobe name to highlight that lobe in both views |
| Reconfigure | Sort areas by lobe or by most affected, conditions by type or by how widespread |
| Explore | Rotate and zoom the brain, inner surface and deep structure views |
| Encode | Switch between cortical thickness and surface area |

Arrow keys move through the matrix and Enter selects, so every cell is reachable without a mouse.

## How the numbers are used

- Effect sizes are Cohen's d from the toolbox's `d_icv` column (case vs control).
- A difference is "reliable" if it passes FDR correction (q < .05). Where only uncorrected p-values were released (Parkinson's, and deep structures for ADHD and depression), p < .05 is used.
- An area counts toward the "conditions affected" overview only if the difference is reliable **and** at least small (|d| >= 0.2), since tiny effects reach significance easily in samples this large.
- The percentage sentence converts d to a percentile assuming roughly normal distributions (Cohen's U3).
- These are group averages. They say nothing about any individual brain and can't be used for diagnosis.

## Rebuilding from the source data

Run these from inside the `enigma-brain-explorer/` folder.

```bash
pip install -r requirements.txt
git clone --depth 1 https://github.com/MICA-MNI/ENIGMA.git
mkdir -p build/out
python build/extract.py ENIGMA/enigmatoolbox/datasets build/out
python build/assemble.py build/out index.html
```

`extract.py` picks the main case-vs-control table for each condition, parses the stats, and exports the fsaverage5 cortex and subcortical meshes. It also splits triangles on area borders so outlines are smooth, simplifies the subcortical meshes, and bakes a sulcal-depth shading map. `assemble.py` drops the data and mesh into `build/template.html`.

## Sources

All statistics come from the ENIGMA working group papers bundled in the ENIGMA Toolbox (Lariviere et al., 2021, *Nature Methods*). The full citation list for each condition is in the page's "About the data" panel. The ENIGMA Toolbox is released under the BSD 3-Clause license.
