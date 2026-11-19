import sys, os, json, gzip, re, base64
import numpy as np, pandas as pd, nibabel as nib, fast_simplification

DS = sys.argv[1]            # .../enigmatoolbox/datasets
OUT = sys.argv[2]
SS = os.path.join(DS, 'summary_statistics')

# ---------- disorders: primary case-vs-control tables ----------
DIS = [
 # id, name, short, group, CT file, SA file, SV file, ref CT, url CT, ref SV, url SV, note
 ('22q','22q11.2 deletion syndrome','22q11.2DS','Neurodevelopmental','22q_case-controls_CortThick','22q_case-controls_CortSurf','22q_case-controls_SubVol',
  'Sun et al., 2020, Mol Psychiatry','https://www.nature.com/articles/s41380-018-0078-5','Ching et al., 2020, Am J Psychiatry','https://ajp.psychiatryonline.org/doi/10.1176/appi.ajp.2019.19060583',''),
 ('adhd','ADHD (all ages)','ADHD','Neurodevelopmental','adhdallages_case-controls_CortThick','adhdallages_case-controls_CortSurf','adhdallages_case-controls_SubVol',
  'Hoogman et al., 2019, Am J Psychiatry','https://ajp.psychiatryonline.org/doi/full/10.1176/appi.ajp.2019.18091033','Hoogman et al., 2017, Lancet Psychiatry','https://www.thelancet.com/journals/lanpsy/article/PIIS2215-0366(17)30049-4/fulltext','Subcortical values are the mean of left and right.'),
 ('asd','Autism spectrum disorder','ASD','Neurodevelopmental','asd_meta-analysis_case-controls_CortThick',None,'asd_meta-analysis_case-controls_SubVol',
  'van Rooij et al., 2018, Am J Psychiatry','https://ajp.psychiatryonline.org/doi/10.1176/appi.ajp.2017.17010100','van Rooij et al., 2018, Am J Psychiatry','https://ajp.psychiatryonline.org/doi/10.1176/appi.ajp.2017.17010100','Only FDR-corrected p-values were released.'),
 ('bd','Bipolar disorder (adult)','Bipolar','Psychiatric','bd_case-controls_CortThick_adult','bd_case-controls_CortSurf_adult','bd_case-controls_SubVol_typeI',
  'Hibar et al., 2018, Mol Psychiatry','https://www.nature.com/articles/mp201773','Hibar et al., 2016, Mol Psychiatry','https://www.nature.com/articles/mp2015227','Subcortical values: bipolar type I vs controls, mean of left and right.'),
 ('mdd','Major depressive disorder (adult)','MDD','Psychiatric','mddadult_case-controls_CortThick','mddadult_case-controls_CortSurf','mdd_case-controls_SubVol',
  'Schmaal et al., 2017, Mol Psychiatry','https://www.nature.com/articles/mp201660','Schmaal et al., 2016, Mol Psychiatry','https://www.nature.com/articles/mp201569','Subcortical values are the mean of left and right.'),
 ('ocd','Obsessive-compulsive disorder (adult)','OCD','Psychiatric','ocdadults_case-controls_CortThick','ocdadults_case-controls_CortSurf','ocdadult_case-controls_SubVol',
  'Boedhoe et al., 2018, Am J Psychiatry','https://ajp.psychiatryonline.org/doi/10.1176/appi.ajp.2017.17050485','Boedhoe et al., 2017, Am J Psychiatry','https://ajp.psychiatryonline.org/doi/10.1176/appi.ajp.2016.16020201','Subcortical values are the mean of left and right.'),
 ('scz','Schizophrenia','Schizophrenia','Psychiatric','scz_case-controls_CortThick','scz_case-controls_CortSurf','scz_case-controls_SubVol',
  'van Erp et al., 2018, Biol Psychiatry','https://www.biologicalpsychiatryjournal.com/article/S0006-3223(18)31517-8/fulltext','van Erp et al., 2016, Mol Psychiatry','https://www.nature.com/articles/mp201563','Subcortical values are the mean of left and right.'),
 ('an','Anorexia nervosa','Anorexia','Psychiatric','anorexia_case-controls_CortThick','anorexia_case-controls_CortSurf','anorexia_case-controls_SubVol',
  'Walton et al., 2022, Biol Psychiatry','https://www.biologicalpsychiatryjournal.com/article/S0006-3223(22)01290-2/abstract','Walton et al., 2022, Biol Psychiatry','https://www.biologicalpsychiatryjournal.com/article/S0006-3223(22)01290-2/abstract',''),
 ('asb','Antisocial behavior','Antisocial','Psychiatric','Antisocial_case-controls_CortThick','Antisocial_case-controls_CortSurf','Antisocial_case-controls_SubVol',
  'Gao et al., 2024, Lancet Psychiatry','https://www.thelancet.com/journals/lanpsy/article/PIIS2215-0366(24)00187-1/fulltext','Gao et al., 2024, Lancet Psychiatry','https://www.thelancet.com/journals/lanpsy/article/PIIS2215-0366(24)00187-1/fulltext',''),
 ('epi','Epilepsy (all)','Epilepsy','Neurological','allepi_case-controls_CortThick',None,'allepi_case-controls_SubVol',
  'Whelan et al., 2018, Brain','https://academic.oup.com/brain/article/141/2/391/4818311','Whelan et al., 2018, Brain','https://academic.oup.com/brain/article/141/2/391/4818311',''),
 ('tlel','Left temporal lobe epilepsy (MTS)','Left TLE','Neurological','tlemtsl_case-controls_CortThick',None,'tlemtsl_case-controls_SubVol',
  'Whelan et al., 2018, Brain','https://academic.oup.com/brain/article/141/2/391/4818311','Whelan et al., 2018, Brain','https://academic.oup.com/brain/article/141/2/391/4818311','Mesial temporal lobe epilepsy with left hippocampal sclerosis.'),
 ('tler','Right temporal lobe epilepsy (MTS)','Right TLE','Neurological','tlemtsr_case-controls_CortThick',None,'tlemtsr_case-controls_SubVol',
  'Whelan et al., 2018, Brain','https://academic.oup.com/brain/article/141/2/391/4818311','Whelan et al., 2018, Brain','https://academic.oup.com/brain/article/141/2/391/4818311','Mesial temporal lobe epilepsy with right hippocampal sclerosis.'),
 ('gge','Genetic generalized epilepsy','GGE','Neurological','gge_case-controls_CortThick',None,'gge_case-controls_SubVol',
  'Whelan et al., 2018, Brain','https://academic.oup.com/brain/article/141/2/391/4818311','Whelan et al., 2018, Brain','https://academic.oup.com/brain/article/141/2/391/4818311',''),
 ('pd',"Parkinson's disease","Parkinson's",'Neurological','parkinsons_case-controls_CortThick_PDvsCN','parkinsons_case-controls_CortSurf_PDvsCN','parkinsons_case-controls_Subvol_PDvsCN',
  'Laansma et al., 2021, Mov Disord','https://movementdisorders.onlinelibrary.wiley.com/doi/10.1002/mds.28706','Laansma et al., 2021, Mov Disord','https://movementdisorders.onlinelibrary.wiley.com/doi/10.1002/mds.28706','Only uncorrected p-values were released.'),
]

def num(x):
    if x is None: return None
    if isinstance(x, (int, float, np.floating, np.integer)):
        return None if pd.isna(x) else float(x)
    s = str(x).strip().replace(',', '')
    if s == '' or s.lower() == 'nan': return None
    m = re.match(r'^<\s*([0-9.eE+-]+)$', s)
    if m: return -float(m.group(1))     # negative => "less than"
    try: return float(s)
    except ValueError: return None

def load(fname, names):
    df = pd.read_csv(os.path.join(SS, fname + '.csv'), dtype=str, on_bad_lines='skip')
    df.columns = [c.strip() for c in df.columns]
    df['Structure'] = df['Structure'].str.strip()
    ncol = 'n_patients' if 'n_patients' in df.columns else [c for c in df.columns if c.startswith('n_') and c != 'n_controls'][0]
    rows = {r['Structure']: r for _, r in df.iterrows()}
    out = []
    for nm in names:
        r = rows.get(nm)
        if r is None:
            out.append(None); continue
        d = num(r['d_icv']); lo = num(r.get('low_ci_icv')); hi = num(r.get('up_ci_icv'))
        if d is None: out.append(None); continue
        if lo is None or hi is None or not (lo - 1e-6 <= d <= hi + 1e-6) or hi - lo > 2:
            lo = hi = None   # drop CIs that are in other units or missing
        out.append([round(d, 4), lo if lo is None else round(lo, 4), hi if hi is None else round(hi, 4),
                    num(r.get('pobs')), num(r.get('fdr_p')), num(r.get('n_controls')), num(r.get(ncol))])
    # drop CI columns entirely if they are mostly unusable (e.g. reported in raw units)
    if sum(e is not None and e[1] is not None for e in out) < len(names) * 0.5:
        for e in out:
            if e: e[1] = e[2] = None
    return out

ref = pd.read_csv(os.path.join(SS, 'scz_case-controls_CortThick.csv'))
CT_NAMES = [s.strip() for s in ref['Structure']][:68]
SV_NAMES = ['Laccumb','Lamyg','Lcaud','Lhippo','Lpal','Lput','Lthal','LLatVent','Raccumb','Ramyg','Rcaud','Rhippo','Rpal','Rput','Rthal','RLatVent']

disorders = []
for (i, nm, sh, grp, ct, sa, sv, rct, uct, rsv, usv, note) in DIS:
    m = {'CT': load(ct, CT_NAMES), 'SV': load(sv, SV_NAMES)}
    if sa: m['SA'] = load(sa, [n for n in CT_NAMES])
    # LatVent of 0 with no stats = not analysed
    for k in (7, 15):
        e = m['SV'][k]
        if e and e[0] == 0 and e[3] in (None, 0) and e[4] in (None, 0): m['SV'][k] = None
    miss = {k: sum(v is None for v in vals) for k, vals in m.items()}
    print(i, miss, file=sys.stderr)
    disorders.append(dict(id=i, name=nm, short=sh, group=grp, refCort=rct, urlCort=uct, refSub=rsv, urlSub=usv,
                          note=note, files={'CT': ct, 'SA': sa, 'SV': sv}, m=m))

# ---------- meshes ----------
def gii(f):
    g = nib.load(os.path.join(DS, 'surfaces', f)); return g.darrays[0].data.astype(np.float64), g.darrays[1].data.astype(np.int64)

lab = np.loadtxt(os.path.join(DS, 'parcellations', 'aparc_fsa5.csv'), dtype=int)
a_idx = list(range(1, 4)) + list(range(5, 39)) + list(range(40, 71))
lab2reg = np.full(71, 255, dtype=np.int64)
lab2reg[a_idx] = np.arange(68)

def vnormals(v, f):
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    n = np.zeros_like(v)
    for k in range(3): np.add.at(n, f[:, k], fn)
    return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)

def sulc_shade(v, f):
    # sulcal-depth-like map: displacement from a heavily smoothed surface along its normal
    import scipy.sparse as sp
    nv = len(v)
    rows = np.concatenate([f[:, 0], f[:, 1], f[:, 2], f[:, 1], f[:, 2], f[:, 0]])
    cols = np.concatenate([f[:, 1], f[:, 2], f[:, 0], f[:, 0], f[:, 1], f[:, 2]])
    A = sp.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(nv, nv)); A.data[:] = 1
    D = sp.diags(1 / np.asarray(A.sum(1)).ravel()); W = D @ A
    vs = v.copy()
    for _ in range(120): vs = 0.5 * vs + 0.5 * (W @ vs)
    ns = vnormals(vs, f)
    depth = np.einsum('ij,ij->i', v - vs, ns)        # >0 on gyral crowns
    for _ in range(3): depth = 0.5 * depth + 0.5 * (W @ depth)
    lo, hi = np.percentile(depth, [3, 97])
    return np.clip((depth - lo) / (hi - lo), 0, 1)

parts = []
lv, lf = gii('fsa5_lh.gii'); rv, rf = gii('fsa5_rh.gii')
for name, v, f, l in (('lh', lv, lf, lab[:10242]), ('rh', rv, rf, lab[10242:])):
    reg = lab2reg[l]           # per vertex region
    shade0 = sulc_shade(v, f)
    V = [tuple(x) for x in v]; mid = {}; SH = list(shade0)
    def mp(a, b):
        k = (a, b) if a < b else (b, a)
        if k not in mid:
            mid[k] = len(V); V.append(tuple((v[a] + v[b]) / 2)); SH.append((shade0[a] + shade0[b]) / 2)
        return mid[k]
    F = []; T = []
    for (i0, i1, i2) in f:
        l0, l1, l2 = reg[i0], reg[i1], reg[i2]
        if l0 == l1 == l2:
            F.append((i0, i1, i2)); T.append(l0); continue
        if l0 != l1 and l1 != l2 and l0 != l2:
            c = len(V); V.append(tuple((v[i0] + v[i1] + v[i2]) / 3)); SH.append((shade0[i0] + shade0[i1] + shade0[i2]) / 3)
            m01, m12, m20 = mp(i0, i1), mp(i1, i2), mp(i2, i0)
            F += [(i0, m01, c), (i0, c, m20), (i1, m12, c), (i1, c, m01), (i2, m20, c), (i2, c, m12)]
            T += [l0, l0, l1, l1, l2, l2]; continue
        # rotate so the odd vertex is first
        if l1 == l2: a, b, cc = i0, i1, i2
        elif l0 == l2: a, b, cc = i1, i2, i0
        else: a, b, cc = i2, i0, i1
        mab, mac = mp(a, b), mp(a, cc)
        F += [(a, mab, mac), (mab, b, cc), (mab, cc, mac)]
        T += [reg[a], reg[b], reg[b]]
    V = np.array(V); F = np.array(F, dtype=np.int64)
    assert len(V) < 65536
    print(name, 'verts', len(v), '->', len(V), 'faces', len(f), '->', len(F), file=sys.stderr)
    parts.append(dict(name=name, v=V, f=F, tri=np.array(T).astype(np.uint8), sh=np.round(np.array(SH) * 255).astype(np.uint8)))

sv_counts = {'lh': [867, 1419, 3012, 3784, 1446, 4003, 3726, 7653], 'rh': [838, 1457, 3208, 3742, 1373, 3871, 3699, 7180]}
for h in ('lh', 'rh'):
    v, f = gii(f'sctx_{h}.gii')
    st = np.cumsum([0] + sv_counts[h])
    for k in range(8):
        a, b = st[k], st[k + 1]
        sel = np.all((f >= a) & (f < b), axis=1)
        assert sel.sum() > 0
        vv, ff = fast_simplification.simplify(v[a:b].astype(np.float32), (f[sel] - a).astype(np.int32), target_reduction=0.7)
        parts.append(dict(name=f'{h}_{SV_NAMES[k + (0 if h=="lh" else 8)]}', v=vv.astype(np.float64), f=ff.astype(np.int64), tri=None,
                          sv=k + (0 if h == 'lh' else 8)))
    # sanity: all faces assigned
    tot = sum(np.all((f >= st[k]) & (f < st[k + 1]), axis=1).sum() for k in range(8))
    print(h, 'sctx faces', len(f), 'assigned', tot, file=sys.stderr)

allv = np.vstack([p['v'] for p in parts])
lo, hi = allv.min(0), allv.max(0)
center = (lo + hi) / 2
scale = (hi - lo).max()
blob = bytearray(); manifest = []
def add(arr):
    off = len(blob); b = arr.tobytes(); blob.extend(b)
    while len(blob) % 4: blob.append(0)
    return off
for p in parts:
    q = np.round((p['v'] - lo) / (hi - lo) * 65535).astype('<u2')
    ent = dict(name=p['name'], nv=len(p['v']), nf=len(p['f']), pos=add(q), idx=add(p['f'].astype('<u2')))
    if p['tri'] is not None: ent['tri'] = add(p['tri']); ent['sh'] = add(p['sh'])
    if 'sv' in p: ent['sv'] = p['sv']
    manifest.append(ent)
gz = gzip.compress(bytes(blob), 9, mtime=0)   # fixed timestamp so rebuilds are byte-identical
print('raw', len(blob), 'gz', len(gz), file=sys.stderr)

json.dump(dict(ctNames=CT_NAMES, svNames=SV_NAMES, disorders=disorders,
               mesh=dict(lo=lo.tolist(), hi=hi.tolist(), parts=manifest)),
          open(os.path.join(OUT, 'data.json'), 'w'), separators=(',', ':'))
open(os.path.join(OUT, 'mesh.b64'), 'w').write(base64.b64encode(gz).decode())
