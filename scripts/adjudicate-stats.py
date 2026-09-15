# Edge-or-bias adjudication statistics. READ-ONLY input CSV from adjudicate-assemble.mjs.
#   uv run --with pandas --with numpy scripts/adjudicate-stats.py <adj.csv>
# Common scale: within-(season,pos) percentile among the COMMON set for each market.
# Primary stat: OLS realizedPct ~ projPct + marketPct; coef on projPct = the disagreement slope.
#   >0 (CI excl 0) -> projector adds signal beyond market -> EDGE; <0 -> BIAS; ~0 -> NEUTRAL.
# CI: season-cluster bootstrap (resample the 12 seasons w/ replacement, refit), 2000 iters.
import sys, numpy as np, pandas as pd

df = pd.read_csv(sys.argv[1])
for c in ["proj","ff","adp","ecr","realized"]:
    df[c] = pd.to_numeric(df[c], errors="coerce")

# higher=better sign. adp/ecr are ranks (lower=better) -> negate so higher=better before percentiling.
SRC = {"proj":1, "ff":1, "adp":-1, "ecr":-1, "realized":1}

def pct_within(sub, col, sign):
    v = sign*sub[col]
    # percentile 0..100, average ranks for ties
    r = v.rank(method="average")
    n = len(sub)
    return (r-1)/(n-1)*100 if n>1 else pd.Series(50.0, index=sub.index)

def build(market):
    """Common set: rows with proj, market, realized all present. Percentiles within (season,pos)."""
    d = df.dropna(subset=["proj", market, "realized"]).copy()
    parts=[]
    for (s,p), sub in d.groupby(["season","pos"]):
        if len(sub) < 6: continue
        sub = sub.copy()
        sub["projPct"] = pct_within(sub,"proj",SRC["proj"])
        sub["mktPct"]  = pct_within(sub,market,SRC[market])
        sub["realPct"] = pct_within(sub,"realized",SRC["realized"])
        parts.append(sub)
    return pd.concat(parts, ignore_index=True)

def ols_bproj(d):
    """coef on projPct in realPct ~ 1 + projPct + mktPct."""
    X = np.column_stack([np.ones(len(d)), d["projPct"].values, d["mktPct"].values])
    y = d["realPct"].values
    beta,_,_,_ = np.linalg.lstsq(X, y, rcond=None)
    return beta  # [intercept, b_proj, b_mkt]

def boot(d, nboot=2000, seed=1):
    rng = np.random.default_rng(seed)
    seasons = d["season"].unique()
    bp=[]; bm=[]
    for _ in range(nboot):
        pick = rng.choice(seasons, size=len(seasons), replace=True)
        parts = [d[d["season"]==s] for s in pick]
        dd = pd.concat(parts, ignore_index=True)
        b = ols_bproj(dd)
        bp.append(b[1]); bm.append(b[2])
    return np.percentile(bp,[2.5,50,97.5]), np.percentile(bm,[2.5,50,97.5])

def report(market):
    d = build(market)
    print(f"\n===================== MARKET = {market.upper()}  (n={len(d)} player-seasons, {d['season'].nunique()} seasons) =====================")
    indep = "INDEPENDENT of projector" if market in ("adp","ecr") else "NOT independent (D16 projector feature)"
    print(f"  [{indep}]")
    print(f"  {'scope':<8} {'n':>5} {'b_proj':>8} {'CI95':>20} {'b_mkt':>8}   verdict")
    for scope in ["POOLED","QB","RB","WR","TE"]:
        dd = d if scope=="POOLED" else d[d["pos"]==scope]
        if len(dd) < 30:
            print(f"  {scope:<8} {len(dd):>5}  (too few)"); continue
        b = ols_bproj(dd)
        (cp, cm) = boot(dd)
        excl0 = cp[0]>0 or cp[2]<0
        verdict = ("EDGE" if b[1]>0 else "BIAS") if excl0 else "NEUTRAL"
        print(f"  {scope:<8} {len(dd):>5} {b[1]:>8.3f} [{cp[0]:>7.3f},{cp[2]:>7.3f}] {b[2]:>8.3f}   {verdict}")
    # bucket by disagreement (projPct - mktPct): terciles; mean abs error proj vs market
    d = d.copy(); d["dis"] = d["projPct"]-d["mktPct"]
    d["ep"]=(d["projPct"]-d["realPct"]).abs(); d["em"]=(d["mktPct"]-d["realPct"]).abs()
    q1,q2 = d["dis"].quantile([1/3,2/3])
    print("  --- buckets by disagreement (projPct - mktPct); mean|err| in percentile pts, lower=closer ---")
    for lab, mask in [("proj<<mkt (fade)", d["dis"]<=q1),("~equal", (d["dis"]>q1)&(d["dis"]<q2)),("proj>>mkt (Goff side)", d["dis"]>=q2)]:
        b=d[mask]
        who = "PROJECTOR closer" if b["ep"].mean()<b["em"].mean() else "MARKET closer"
        print(f"     {lab:<22} n={len(b):>4}  proj|err|={b['ep'].mean():5.1f}  mkt|err|={b['em'].mean():5.1f}  -> {who}")
    # top-disagreement decile (proj>>mkt)
    d10 = d[d["dis"]>=d["dis"].quantile(0.9)]
    who = "PROJECTOR closer" if d10["ep"].mean()<d10["em"].mean() else "MARKET closer"
    print(f"     top disagreement DECILE (proj>>mkt) n={len(d10)}: proj|err|={d10['ep'].mean():.1f} mkt|err|={d10['em'].mean():.1f} -> {who}")
    return d

for m in ["adp","ecr","ff"]:
    report(m)

# ---------------- QB COMPRESSION: proj vs market vs realized spread (points) ----------------
print("\n\n===================== QB COMPRESSION (points spread & SD, fixed pool = QBs with proj+ff+realized) =====================")
print(f"  {'season':>6} {'n':>3} {'projSD':>7} {'ffSD':>7} {'realSD':>7} | {'projRange':>9} {'ffRange':>8} {'realRange':>9}")
qd = df.dropna(subset=["proj","ff","realized"])
sds=[]
for s,sub in qd[qd["pos"]=="QB"].groupby("season"):
    if len(sub)<8: continue
    def rng(c):
        v=np.sort(sub[c].values)[::-1][:16]; return v[0]-v[-1]
    projSD, ffSD, realSD = sub["proj"].std(), sub["ff"].std(), sub["realized"].std()
    sds.append((projSD,ffSD,realSD))
    print(f"  {s:>6} {len(sub):>3} {projSD:>7.1f} {ffSD:>7.1f} {realSD:>7.1f} | {rng('proj'):>9.0f} {rng('ff'):>8.0f} {rng('realized'):>9.0f}")
sds=np.array(sds)
print(f"  MEAN across seasons: projSD={sds[:,0].mean():.1f}  ffSD={sds[:,1].mean():.1f}  realizedSD={sds[:,2].mean():.1f}")
print("  -> if realizedSD >> projSD, QBs ARE differentiable and the projector's compression LEAVES SIGNAL (under-differentiates).")

# ---------------- GOFF PROFILE: proj rates QB top-6, market (ECR/ADP/FF) rates ~QB12+ ----------------
print("\n\n===================== GOFF PROFILE: projector QB<=6, market QB>=12 -- what did they realize? =====================")
def qbrank(sub, col, sign):
    return (sign*sub[col]).rank(ascending=False, method="min")
# use ff as market rank (points) since full range; also compute realized qb rank
prof=[]
for s,sub in df[df["pos"]=="QB"].groupby("season"):
    sub=sub.dropna(subset=["proj","realized"]).copy()
    if len(sub)<12: continue
    sub["pR"]=qbrank(sub,"proj",1)
    sub["rR"]=qbrank(sub,"realized",1)
    if sub["ff"].notna().sum()>=12:
        sub["mR"]=qbrank(sub.assign(ff=sub["ff"].fillna(-1)),"ff",1)
    else:
        sub["mR"]=np.nan
    hit = sub[(sub["pR"]<=6) & (sub["mR"]>=12)]
    for _,r in hit.iterrows():
        prof.append((s, r["name_key"], int(r["pR"]), int(r["mR"]), int(r["rR"]), round(r["realized"],1)))
print(f"  {'season':>6} {'player':<22} {'projQB':>6} {'mktQB':>6} {'realQB':>6} {'realPts':>8}")
for p in prof:
    print(f"  {p[0]:>6} {p[1]:<22} {p[2]:>6} {p[3]:>6} {p[4]:>6} {p[5]:>8}")
if prof:
    import statistics
    pj=[p[2] for p in prof]; mk=[p[3] for p in prof]; rz=[p[4] for p in prof]
    close_proj=sum(1 for p in prof if abs(p[2]-p[4])<abs(p[3]-p[4]))
    print(f"  n={len(prof)}  mean projQB={statistics.mean(pj):.1f} mktQB={statistics.mean(mk):.1f} realizedQB={statistics.mean(rz):.1f}")
    print(f"  projector rank was CLOSER to realized than market in {close_proj}/{len(prof)} cases")
    print(f"  median realized QB rank of these projector-darlings: {statistics.median(rz)}")
