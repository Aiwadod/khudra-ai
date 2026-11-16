"""Load the French-bakery point-of-sale log and turn it into a daily demand panel.

Source: "French bakery daily sales" (M. Gimbert, Kaggle) - 234k receipt lines,
2021-01-02 .. 2022-09-30. The CSV is not redistributed here; `download()` fetches a public mirror.
"""
from pathlib import Path
import urllib.request
import pandas as pd

RAW = Path(__file__).resolve().parents[1] / "data" / "bakery_sales.csv"
MIRROR = "https://raw.githubusercontent.com/ibaburbek/bakery_sales_pbi/main/Bakery%20sales.csv"
NOT_PRODUCTS = {"COUPE", "."}          # "COUPE" is a bread-slicing service, not an item that is baked
N_ITEMS = 15


def download(path: Path = RAW) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(MIRROR, path)
    return path


def load_panel(n_items: int = N_ITEMS) -> pd.DataFrame:
    """Return long frame [date, item, y, price] for the top-`n_items` products on days the shop was open."""
    raw = pd.read_csv(download(), index_col=0)
    raw["price"] = (raw["unit_price"].str.replace("€", "").str.replace(",", ".").str.strip().astype(float))
    raw = raw[(raw["Quantity"] > 0) & ~raw["article"].isin(NOT_PRODUCTS)]          # drop refunds / non-products
    raw["date"] = pd.to_datetime(raw["date"])
    top = raw.groupby("article")["Quantity"].sum().nlargest(n_items).index
    raw = raw[raw["article"].isin(top)]
    daily = raw.groupby(["date", "article"])["Quantity"].sum().unstack(fill_value=0.0)   # open days only
    price = raw.groupby("article")["price"].median()
    long = daily.stack().rename("y").reset_index().rename(columns={"article": "item"})
    long["price"] = long["item"].map(price)
    return long.sort_values(["item", "date"]).reset_index(drop=True)


if __name__ == "__main__":
    p = load_panel()
    print(p.groupby("item")["y"].agg(["mean", "std", "max"]).round(1))
    print(p["date"].min(), p["date"].max(), p["date"].nunique(), "open days")
