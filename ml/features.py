"""Leak-free features for a 1-day-ahead forecast: everything is known the evening before."""
import numpy as np
import pandas as pd

LAGS = (1, 2, 3, 7, 14, 21, 28)
FEATURES = (["dow", "month", "dom", "weekofyear", "is_weekend", "days_since_prev_open", "trend"]
            + [f"lag_{l}" for l in LAGS]
            + ["roll7_mean", "roll28_mean", "roll28_std", "same_dow_med8", "same_dow_mean4", "shop_total_lag1", "shop_total_roll7"])


def add_features(panel: pd.DataFrame) -> pd.DataFrame:
    df = panel.sort_values(["item", "date"]).copy()
    df["dow"] = df["date"].dt.dayofweek
    df["month"] = df["date"].dt.month
    df["dom"] = df["date"].dt.day
    df["weekofyear"] = df["date"].dt.isocalendar().week.astype(int)
    df["is_weekend"] = (df["dow"] >= 5).astype(int)
    df["trend"] = (df["date"] - df["date"].min()).dt.days
    g = df.groupby("item")["y"]
    df["days_since_prev_open"] = df.groupby("item")["date"].diff().dt.days.fillna(1)
    for l in LAGS:
        df[f"lag_{l}"] = g.shift(l)
    df["roll7_mean"] = g.transform(lambda s: s.shift(1).rolling(7).mean())
    df["roll28_mean"] = g.transform(lambda s: s.shift(1).rolling(28).mean())
    df["roll28_std"] = g.transform(lambda s: s.shift(1).rolling(28).std())
    by = df.groupby(["item", "dow"])["y"]                       # same weekday, previous weeks only
    df["same_dow_med8"] = by.transform(lambda s: s.shift(1).rolling(8, min_periods=3).median())
    df["same_dow_mean4"] = by.transform(lambda s: s.shift(1).rolling(4, min_periods=2).mean())
    tot = df.groupby("date")["y"].sum().rename("shop_total")
    tot_feats = pd.DataFrame({"shop_total_lag1": tot.shift(1), "shop_total_roll7": tot.shift(1).rolling(7).mean()})
    df = df.merge(tot_feats, left_on="date", right_index=True, how="left")
    df["item_code"] = df["item"].astype("category")
    return df


def baselines(df: pd.DataFrame) -> pd.DataFrame:
    """Simple forecasts every row can be compared against."""
    out = df.copy()
    out["naive"] = out["lag_1"]
    out["seasonal_naive"] = out["lag_7"]
    out["moving_avg_7"] = out["roll7_mean"]
    out["khudra_heuristic"] = out["same_dow_med8"]     # what the Khudra app shipped with: median of the same weekday, last 8 weeks
    return out
