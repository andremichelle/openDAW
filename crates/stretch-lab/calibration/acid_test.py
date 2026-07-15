"""Run the perceptual scorer over the whole calibration set and check ordering."""
import sys
sys.path.insert(0, "stretch-lab/calibration")
from score import score
rows = []
for line in open("stretch-lab/calibration/verdicts.tsv"):
    if line.startswith("#") or not line.strip(): continue
    f, s, v, words = line.rstrip("\n").split("\t")
    try:
        d = score("stretch-lab/" + f, "stretch-lab/" + s)
    except Exception as e:
        d = float("nan"); words += f"  [ERR {e}]"
    rows.append((float(v), d, f.split("/")[-1], words))
    print(f"verdict {v}  fad {d:8.3f}  {f.split('/')[-1]}")
good = [d for v, d, *_ in rows if v <= 1]
bad = [d for v, d, *_ in rows if v >= 3]
if good and bad:
    ok = max(good) < min(bad)
    print(f"\nseparation: worst-good {max(good):.3f} vs best-bad {min(bad):.3f} -> {'ORDERED' if ok else 'NOT ordered'}")
