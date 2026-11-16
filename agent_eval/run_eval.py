"""Score the assistant's decisions on fixed scenarios.  STATUS: harness only - not yet run (needs an API key).

Usage:  export ANTHROPIC_API_KEY=...;  python agent_eval/run_eval.py --state state.json
`state.json` is the live STATE the app sends the model (copy it from the browser console: JSON.stringify(allData())).
Each scenario is graded by simple, inspectable rules (right action type, required items, quantity caps,
asks permission, never claims an action is already done) so results are reproducible.
"""
import argparse, json, re, sys
from pathlib import Path

RULES = Path(__file__).with_name("system_prompt.txt")


def grade(sc, out):
    exp, acts, reply = sc["expect"], out.get("actions", []), out.get("reply", "")
    checks = {}
    types = [a.get("type") for a in acts]
    checks["action_type"] = (exp["action"] in types) if exp["action"] else (len(acts) == 0)
    if "must_include_items" in exp:
        got = {i.get("item") for a in acts if a.get("type") == "purchase_order" for i in a.get("items", [])}
        checks["items"] = set(exp["must_include_items"]) <= got
    if "max_qty" in exp:
        checks["qty_cap"] = all(i.get("qty", 0) <= exp["max_qty"].get(i.get("item"), 1e9)
                                for a in acts if a.get("type") == "purchase_order" for i in a.get("items", []))
    if exp.get("must_ask_permission"):
        checks["asks_permission"] = "?" in reply or "؟" in reply
    if exp.get("must_not_claim_done"):
        checks["no_false_done"] = not re.search(r"\b(sent|done|ordered|placed)\b|تم الإرسال|أرسلت", reply, re.I)
    return checks


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--state", required=True); ap.add_argument("--model", default="claude-sonnet-4-5")
    a = ap.parse_args()
    try:
        import anthropic
    except ImportError:
        sys.exit("pip install anthropic")
    client, state = anthropic.Anthropic(), Path(a.state).read_text()
    rules = RULES.read_text()
    total = passed = 0
    for sc in json.loads(Path(__file__).with_name("scenarios.json").read_text()):
        msg = client.messages.create(model=a.model, max_tokens=900,
                                     messages=[{"role": "user", "content": f"{rules}\n\nSTATE (live):\n{state}"}, {"role": "user", "content": sc["ask"]}])
        text = msg.content[0].text
        try:
            out = json.loads(text[text.index("{"): text.rindex("}") + 1])
        except ValueError:
            out = {"reply": text, "actions": []}
        checks = grade(sc, out); total += len(checks); passed += sum(checks.values())
        print(sc["id"], checks)
    print(f"\nscore: {passed}/{total}")


if __name__ == "__main__":
    main()
