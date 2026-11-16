"""Rolling-origin backtest: baselines vs LightGBM (point + quantile), then a newsvendor ordering simulation."""
import json
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from data import load_panel
from features import add_features, baselines, FEATURES

OUT = Path(__file__).resolve().parents[1] / "reports"
TEST_DAYS, STEP = 168, 28            # last 24 weeks are test; refit every 4 weeks on everything before
FOOD_COST = 0.35                     # assumption: ingredients cost 35% of the shelf price; unsold = thrown away
QS = (0.5, 0.65, 0.8, 0.9)
PARAMS = dict(n_estimators=400, learning_rate=0.03, num_leaves=31, min_child_samples=20, subsample=0.8,
              subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, random_state=7)
COLS = FEATURES + ["item_code"]


def fit_predict(train, test, **kw):
    m = lgb.LGBMRegressor(**{**PARAMS, **kw})
    m.fit(train[COLS], train["y"])
    return np.clip(m.predict(test[COLS]), 0, None), m


def run():
    df = baselines(add_features(load_panel())).dropna(subset=FEATURES).reset_index(drop=True)
    dates = np.sort(df["date"].unique())
    test_dates = dates[-TEST_DAYS:]
    preds, imp = [], None
    for i in range(0, TEST_DAYS, STEP):
        fold = test_dates[i:i + STEP]
        train, test = df[df["date"] < fold[0]], df[df["date"].isin(fold)].copy()
        test["lgbm"], m = fit_predict(train, test, objective="l1")
        imp = pd.Series(m.feature_importances_, index=COLS) if imp is None else imp + m.feature_importances_
        for q in QS:
            test[f"q{int(q*100)}"], _ = fit_predict(train, test, objective="quantile", alpha=q)
        preds.append(test)
    P = pd.concat(preds).reset_index(drop=True)

    # ---------- forecast accuracy ----------
    models = ["naive", "seasonal_naive", "moving_avg_7", "khudra_heuristic", "lgbm"]
    rows = []
    for m in models:
        e = P[m] - P["y"]
        rows.append(dict(model=m, MAE=e.abs().mean(), WAPE=e.abs().sum() / P["y"].sum() * 100, bias=e.sum() / P["y"].sum() * 100))
    acc = pd.DataFrame(rows).set_index("model").round(2)
    per_item = pd.DataFrame({m: P.groupby("item").apply(lambda g: (g[m] - g["y"]).abs().sum() / g["y"].sum() * 100) for m in ["khudra_heuristic", "lgbm"]}).round(1)
    per_item["improvement_pct"] = ((per_item["khudra_heuristic"] - per_item["lgbm"]) / per_item["khudra_heuristic"] * 100).round(1)
    cover = {f"q{int(q*100)}": round(float((P["y"] <= P[f"q{int(q*100)}"]).mean() * 100), 1) for q in QS}

    # ---------- newsvendor: how much to bake when leftovers are thrown away ----------
    cr = 1 - FOOD_COST                                  # critical ratio = underage / (underage + overage) = (p-c)/p
    resid_sd = (P["khudra_heuristic"] - P["y"]).groupby(P["item"]).transform("std")
    policies = {
        "seasonal_naive": P["seasonal_naive"],
        "heuristic": P["khudra_heuristic"],
        "heuristic + safety stock": P["khudra_heuristic"] + 0.385 * resid_sd,   # z for a 65% service level, same target as below
        "lgbm point forecast": P["lgbm"],
        "lgbm quantile @ critical ratio": P["q65"],
        "perfect foresight": P["y"],
    }
    sim = []
    for name, q in policies.items():
        q = np.ceil(np.clip(q, 0, None))
        sold = np.minimum(q, P["y"])
        profit = (P["price"] * sold - FOOD_COST * P["price"] * q).sum()
        sim.append(dict(policy=name, profit_eur=profit, waste_pct=(q - sold).sum() / q.sum() * 100,
                        lost_sales_pct=(P["y"] - sold).sum() / P["y"].sum() * 100, stockout_days_pct=(q < P["y"]).mean() * 100))
    sim = pd.DataFrame(sim).set_index("policy")
    sim["vs_heuristic_pct"] = (sim["profit_eur"] / sim.loc["heuristic", "profit_eur"] - 1) * 100
    sim = sim.round(1)

    # ---------- write ----------
    OUT.mkdir(exist_ok=True); (OUT / "figures").mkdir(exist_ok=True)
    res = dict(dataset=dict(rows=int(len(df)), items=int(df["item"].nunique()), open_days=int(len(dates)), test_days=TEST_DAYS,
                            start=str(dates[0])[:10], end=str(dates[-1])[:10]),
               accuracy=acc.reset_index().to_dict("records"), per_item=per_item.reset_index().to_dict("records"),
               quantile_coverage_pct=cover, critical_ratio=cr, food_cost_assumption=FOOD_COST,
               newsvendor=sim.reset_index().to_dict("records"),
               top_features=(imp / imp.sum() * 100).sort_values(ascending=False).head(8).round(1).to_dict())
    (OUT / "results.json").write_text(json.dumps(res, indent=2))
    P[["date", "item", "y", "price"] + models + [f"q{int(q*100)}" for q in QS]].to_csv(OUT / "predictions.csv", index=False)

    fig, ax = plt.subplots(1, 3, figsize=(16, 4.4))
    acc["WAPE"].plot.barh(ax=ax[0], color=["#b8c4bb"] * 4 + ["#0d3b2c"]); ax[0].set_title("Forecast error (WAPE %, lower is better)"); ax[0].invert_yaxis()
    one = P[P["item"] == "CROISSANT"].tail(56)
    ax[1].plot(one["date"], one["y"], color="#222", lw=1.6, label="actual"); ax[1].plot(one["date"], one["lgbm"], color="#0d3b2c", label="LightGBM")
    ax[1].plot(one["date"], one["khudra_heuristic"], color="#ff5b3a", ls="--", label="heuristic"); ax[1].fill_between(one["date"], one["q50"], one["q90"], color="#c9f26b", alpha=.5, label="q50-q90")
    ax[1].set_title("Croissant: last 8 test weeks"); ax[1].legend(fontsize=8); ax[1].tick_params(axis="x", rotation=30)
    s2 = sim.drop("perfect foresight")
    ax[2].scatter(s2["waste_pct"], s2["lost_sales_pct"], s=70, color="#0d3b2c")
    for n, r in s2.iterrows(): ax[2].annotate(n, (r["waste_pct"], r["lost_sales_pct"]), fontsize=8, xytext=(5, 4), textcoords="offset points")
    ax[2].set_xlabel("waste (% of baked units)"); ax[2].set_ylabel("lost sales (% of demand)"); ax[2].set_title("Ordering policies: waste vs lost sales")
    plt.tight_layout(); plt.savefig(OUT / "figures" / "results.png", dpi=130)
    print(acc, "\n\n", per_item, "\n\ncoverage", cover, "\n\n", sim, "\n\n", res["top_features"])


if __name__ == "__main__":
    run()
