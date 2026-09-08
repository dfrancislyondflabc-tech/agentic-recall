#!/usr/bin/env python3
"""ForgetEval adapter for recall-mcp (Phase 1c).

Usage:
    python3 scripts/forgeteval/adapter.py --lethe /path/to/lethe/clone [--suite adversarial]

Implements the ForgetEval Adapter protocol by driving a persistent Node
bridge (bridge.mjs) that runs the REAL retrieval stack against a fully
sandboxed corpus (every root and index path redirected — see the bridge
header). purge() raises NotImplementedError: the server deliberately has
no delete path, and ForgetEval scores that honestly as N/A.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


class MemoryMcpAdapter:
    name = "recall-mcp"

    def __init__(self):
        self.proc = subprocess.Popen(
            ["node", str(HERE / "bridge.mjs")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, cwd=str(REPO),
        )

    def _call(self, **msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("bridge died")
        out = json.loads(line)
        if not out.get("ok"):
            raise RuntimeError(out.get("error") or "bridge error")
        return out

    def reset(self) -> None:
        self._call(op="reset")

    def inscribe(self, text: str) -> int:
        return self._call(op="inscribe", text=text)["id"]

    def recall_texts(self, query: str, k: int = 5) -> list[str]:
        return self._call(op="recall", query=query, k=k)["texts"]

    def supersede(self, old_query: str, new_text: str) -> None:
        self._call(op="supersede", old_query=old_query, new_text=new_text)

    def release(self, query: str) -> int:
        return self._call(op="release", query=query)["count"]

    def purge(self, query: str) -> int:
        raise NotImplementedError(
            "recall-mcp has no delete path, by design (read-only corpora, "
            "demote-not-delete). Scored N/A, which is the honest reflection."
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lethe", required=True, help="path to the lethe clone (read-only)")
    ap.add_argument("--suite", default="adversarial", choices=["smoke", "adversarial"])
    args = ap.parse_args()

    sys.path.insert(0, str(Path(args.lethe).resolve()))
    from bench.forgeteval.run import run_adapter, report          # noqa: E402
    if args.suite == "smoke":
        from bench.forgeteval.tests import ALL_TESTS as SUITE     # noqa: E402
    else:
        from bench.forgeteval.adversarial import ADVERSARIAL_TESTS as SUITE  # noqa: E402

    adapter = MemoryMcpAdapter()
    summary = run_adapter(adapter, SUITE, verbose=False)
    report(summary, adapter.name)


if __name__ == "__main__":
    main()
