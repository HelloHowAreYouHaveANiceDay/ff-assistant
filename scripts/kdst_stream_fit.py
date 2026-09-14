# Real K/DST matchup model vs the shipped season-line floor.
#   uv run --with scikit-learn --with numpy scripts/kdst_stream_fit.py <csv>
# Read-only analysis. Prints: connection proof, accuracy gate (paired season), pick/room test.
import csv, sys, math
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor

PATH = sys.argv[1] if len(sys.argv) > 1 else "kdst.csv"
FEATS = ["opp_pa_pos","opp_pa_pos_n","opp_off_sacks_allowed_pg","opp_off_giveaways_pg",
         "opp_implied_total","opp_def_sacks_pg","opp_def_takeaways_pg",
         "opp_pass_yds_allowed_pg","opp_rush_yds_allowed_pg","roof_dome","team_fga_pg","team_pat_pg"]

rows=[]
with open(PATH, newline="") as f:
    for r in csv.DictReader(f):
        d={"season":int(r["season"]),"week":int(r["week"]),"pos":r["pos"],
           "target":float(r["target"]),"floor":float(r["floor"])}
        ok=True
        for c in FEATS:
            v=r[c]
            if v=="" or v is None: ok=False; break
            d[c]=float(v)
        if ok: rows.append(d)

SEASONS=sorted(set(r["season"] for r in rows))
SEL=[y for y in SEASONS if y<=2020]     # selection block (decision)
HOLD=[y for y in SEASONS if y>=2021]     # confirm block, scored once

def phi(z): return math.exp(-0.5*z*z)/math.sqrt(2*math.pi)
def Phi(z): return 0.5*(1+math.erf(z/math.sqrt(2)))
def crps_gauss(mu,sig,y):
    if sig<=1e-6: return abs(y-mu)
    z=(y-mu)/sig
    return sig*(z*(2*Phi(z)-1)+2*phi(z)-1/math.sqrt(math.pi))

def paired_floor(per_season_impr, seasons, label):
    # per_season_impr: dict season-> (floor_metric - model_metric); positive = model better (lower metric)
    xs=np.array([per_season_impr[y] for y in seasons])
    n=len(xs); m=xs.mean(); se=xs.std(ddof=1)/math.sqrt(n)
    floor=2.9*se
    # season bootstrap CI
    rng=np.random.default_rng(12345); B=5000; boots=[]
    for _ in range(B):
        idx=rng.integers(0,n,n); boots.append(xs[idx].mean())
    boots=np.sort(boots)
    lo,hi=boots[int(B*0.025)],boots[int(B*0.975)]
    wins=int((xs>0).sum())
    print(f"    {label} ({n} seasons: {seasons[0]}-{seasons[-1]})")
    print(f"      mean improvement (floor - model): {m:+.4f}   [lower metric is better; + = model wins]")
    print(f"      SE across seasons: {se:.4f}   2.9*SE floor: {floor:.4f}")
    print(f"      season bootstrap 95% CI: [{lo:+.4f}, {hi:+.4f}]   wins/losses: {wins}/{n-wins}")
    verdict = "BEATS FLOOR" if m>floor else "within floor (noise)/negative -> NULL"
    print(f"      VERDICT: {verdict}")
    return m, floor, m>floor

def fit_pos(pos):
    data=[r for r in rows if r["pos"]==pos]
    print("\n"+"="*78)
    print(f"POSITION {pos}   n={len(data)}   seasons {SEASONS[0]}-{SEASONS[-1]}")
    print("="*78)
    X=np.array([[r[c] for c in FEATS] for r in data])
    y=np.array([r["target"] for r in data])
    fl=np.array([r["floor"] for r in data])
    yr=np.array([r["season"] for r in data])

    # ---- LOSO predictions for ridge and gbm ----
    pred_ridge=np.full(len(data),np.nan); pred_gbm=np.full(len(data),np.nan)
    coef_accum=np.zeros(len(FEATS)); imp_accum=np.zeros(len(FEATS)); nf=0
    for hold in SEASONS:
        tr=yr!=hold; te=yr==hold
        if tr.sum()<50 or te.sum()==0: continue
        mu=X[tr].mean(0); sd=X[tr].std(0); sd[sd<1e-9]=1
        Xtr=(X[tr]-mu)/sd; Xte=(X[te]-mu)/sd
        rg=Ridge(alpha=10.0).fit(Xtr,y[tr]); pred_ridge[te]=rg.predict(Xte)
        coef_accum+=rg.coef_; nf+=1
        gb=HistGradientBoostingRegressor(max_depth=3,max_iter=200,learning_rate=0.05,
                                         min_samples_leaf=40,l2_regularization=1.0,random_state=0).fit(X[tr],y[tr])
        pred_gbm[te]=gb.predict(X[te])
        # permutation importance (cheap): shuffle each feature on held-out, measure MAE rise
        base=np.abs(gb.predict(X[te])-y[te]).mean()
        rng=np.random.default_rng(1)
        for j in range(len(FEATS)):
            Xp=X[te].copy(); Xp[:,j]=rng.permutation(Xp[:,j])
            imp_accum[j]+=np.abs(gb.predict(Xp)-y[te]).mean()-base
    coef=coef_accum/nf; imp=imp_accum/nf

    # ================= CONNECTION PROOF =================
    print("\n[CONNECTION PROOF]")
    print("  Ridge standardized coefficients (mean over folds; |coef| = pts of swing per 1 SD):")
    order=np.argsort(-np.abs(coef))
    for j in order:
        print(f"     {FEATS[j]:<28} {coef[j]:+.3f}")
    print("  GBM permutation importance (MAE rise when feature shuffled; >0 = used):")
    for j in np.argsort(-imp):
        print(f"     {FEATS[j]:<28} {imp[j]:+.4f}")
    # positive control: OOS corr(pred,actual) vs corr(floor,actual)
    def corr(a,b):
        a=np.asarray(a); b=np.asarray(b);
        return np.corrcoef(a,b)[0,1]
    cR=corr(pred_ridge,y); cG=corr(pred_gbm,y); cF=corr(fl,y)
    print(f"  OUT-OF-SAMPLE corr(pred, actual):  ridge={cR:.4f}  gbm={cG:.4f}   vs   floor={cF:.4f}")
    print(f"     -> features CONNECTED if model corr > floor corr: ridge {'YES' if cR>cF else 'no'}, gbm {'YES' if cG>cF else 'no'}")
    # fault injection: a leak feature target+noise MUST dominate
    rng=np.random.default_rng(7)
    Xl=np.column_stack([X, y+rng.normal(0,3.0,len(y))])
    leak_corr=[]
    for hold in SEASONS:
        tr=yr!=hold; te=yr==hold
        if tr.sum()<50 or te.sum()==0: continue
        mu=Xl[tr].mean(0); sd=Xl[tr].std(0); sd[sd<1e-9]=1
        rg=Ridge(alpha=10.0).fit((Xl[tr]-mu)/sd,y[tr])
        leak_corr.append(rg.coef_[-1])
    print(f"  FAULT-INJECTION control: a leak feature (target+noise) gets standardized coef "
          f"{np.mean(leak_corr):+.3f} (must dominate real coefs -> harness can detect signal)")

    # ================= ACCURACY GATE (paired season) =================
    # per-season metrics for floor vs best model (ridge and gbm both reported)
    print("\n[ACCURACY GATE vs floor -- paired by SEASON]")
    def per_season_metric(pred, metricfn):
        out={}
        # sigma per arm estimated globally OOS (constant) for CRPS
        return out
    # global OOS sigma per arm for gaussian CRPS
    sig_fl=np.sqrt(((y-fl)**2).mean()); sig_R=np.sqrt(np.nanmean((y-pred_ridge)**2)); sig_G=np.sqrt(np.nanmean((y-pred_gbm)**2))
    print(f"  OOS RMSE:  floor={sig_fl:.3f}  ridge={sig_R:.3f}  gbm={sig_G:.3f}")
    print(f"  OOS MAE :  floor={np.abs(y-fl).mean():.3f}  ridge={np.nanmean(np.abs(y-pred_ridge)):.3f}  gbm={np.nanmean(np.abs(y-pred_gbm)):.3f}")
    for mname, pred, sig in [("ridge",pred_ridge,sig_R),("gbm",pred_gbm,sig_G)]:
        for metric in ["MAE","CRPS"]:
            impr={}
            for s in SEASONS:
                sel=yr==s
                if metric=="MAE":
                    mfloor=np.abs(y[sel]-fl[sel]).mean()
                    mmodel=np.abs(y[sel]-pred[sel]).mean()
                else:
                    mfloor=np.mean([crps_gauss(fl[i],sig_fl,y[i]) for i in np.where(sel)[0]])
                    mmodel=np.mean([crps_gauss(pred[i],sig,y[i]) for i in np.where(sel)[0]])
                impr[s]=mfloor-mmodel
            print(f"\n  -- {mname} vs floor, {metric} --")
            paired_floor(impr, SEL, "SELECTION")
            paired_floor(impr, HOLD, "HOLDOUT CONFIRM")

    # ================= ROOM / PICK TEST =================
    # each (season,week): rank pool by model pred and by floor; compare realized target of the top pick.
    # full pool AND streamable tier (exclude top-12 by floor, i.e. the always-rostered starters).
    print("\n[ROOM / PICK TEST -- realized pts of the top pick, paired by season]")
    best_pred = pred_gbm if cG>=cR else pred_ridge
    best_name = "gbm" if cG>=cR else "ridge"
    print(f"  (using {best_name}; positive = model pick beats floor pick on realized pts)")
    idx_by_sw={}
    for i,r in enumerate(data):
        idx_by_sw.setdefault((r["season"],r["week"]),[]).append(i)
    for tier,thresh in [("FULL POOL",0),("STREAMABLE (exclude top-12 by floor)",12)]:
        model_season={}; floor_season={}; avg_season={}
        for (s,w),idxs in idx_by_sw.items():
            idxs=list(idxs)
            if thresh>0:
                ordf=sorted(idxs,key=lambda i:-fl[i])
                idxs=ordf[thresh:]
            if len(idxs)<2: continue
            mp=max(idxs,key=lambda i:best_pred[i])
            fp=max(idxs,key=lambda i:fl[i])
            model_season.setdefault(s,[]).append(y[mp])
            floor_season.setdefault(s,[]).append(y[fp])
            avg_season.setdefault(s,[]).append(np.mean([y[i] for i in idxs]))
        impr={s:np.mean(model_season[s])-np.mean(floor_season[s]) for s in model_season}
        mm=np.mean([np.mean(model_season[s]) for s in SEASONS if s in model_season])
        ff=np.mean([np.mean(floor_season[s]) for s in SEASONS if s in model_season])
        aa=np.mean([np.mean(avg_season[s]) for s in SEASONS if s in model_season])
        print(f"\n  {tier}: model-pick realized {mm:.2f} vs floor-pick {ff:.2f} (random-avail {aa:.2f}) pts/wk")
        paired_floor(impr, SEL, "SELECTION")
        paired_floor(impr, HOLD, "HOLDOUT CONFIRM")

for pos in ["DST","K"]:
    fit_pos(pos)
