import argparse
import json
import statistics
import time
from pathlib import Path

from .core import SearchService


def evaluate(service, cases, k, cost_per_query=0.0):
    recalls, latencies, rows = [], [], []
    for case in cases:
        expected = set(case["relevant_ids"])
        if not expected:
            raise ValueError("Every query needs at least one relevant image ID")
        start = time.perf_counter()
        results = service.search(case["query"], k)
        latency = (time.perf_counter() - start) * 1000
        retrieved = [result["id"] for result in results]
        recall = len(expected.intersection(retrieved)) / len(expected)
        recalls.append(recall)
        latencies.append(latency)
        rows.append({"query": case["query"], "recall_at_k": recall, "latency_ms": round(latency, 2), "retrieved_ids": retrieved})
    sorted_latencies = sorted(latencies)
    p95_index = max(0, __import__("math").ceil(0.95 * len(sorted_latencies)) - 1)
    return {
        "queries": len(cases), "k": k,
        "mean_recall_at_k": round(statistics.mean(recalls), 4),
        "latency_p50_ms": round(statistics.median(latencies), 2),
        "latency_p95_ms": round(sorted_latencies[p95_index], 2),
        "estimated_cost_per_query_usd": cost_per_query,
        "note": "Cost is a supplied infrastructure estimate; local CPU usage is not billed here.",
        "details": rows,
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate labeled image search queries")
    parser.add_argument("labels", type=Path, help="JSON list with query and relevant_ids")
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--cost-per-query", type=float, default=0.0)
    args = parser.parse_args()
    if args.k < 1 or args.cost_per_query < 0:
        parser.error("k must be positive and cost must be nonnegative")
    cases = json.loads(args.labels.read_text())
    if not isinstance(cases, list) or not cases:
        parser.error("labels must be a nonempty JSON list")
    print(json.dumps(evaluate(SearchService(), cases, args.k, args.cost_per_query), indent=2))


if __name__ == "__main__":
    main()
