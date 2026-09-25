"""Command line entry point for the expense tracker."""

from __future__ import annotations

import sys
from pathlib import Path

from .models import Category
from .storage import JsonStore
from .tracker import ExpenseTracker


def build_tracker(path: Path) -> ExpenseTracker:
    """Wire up the default application stack: a JSON store behind a tracker."""
    store = JsonStore(path)
    tracker = ExpenseTracker(store)
    tracker.set_budget(Category.GROCERIES, "400.00")
    tracker.set_budget(Category.TRANSPORT, "120.00")
    return tracker


def seed_demo_data(tracker: ExpenseTracker) -> None:
    """Record a handful of expenses so the report has something to show."""
    tracker.record("Supermarket run", "62.40")
    tracker.record("Metro monthly pass", "55.00")
    tracker.record("Cinema tickets", "24.00")
    tracker.record("Bakery", "8.75")


def main(argv: list[str] | None = None) -> int:
    """Seed a demo ledger and print this month's report."""
    argv = argv if argv is not None else sys.argv[1:]
    path = Path(argv[0]) if argv else Path("expenses.json")

    tracker = build_tracker(path)
    seed_demo_data(tracker)

    month = date_prefix()
    print(tracker.monthly_report(month).render())
    print("\nShare of spend:")
    print(tracker.breakdown().render())
    return 0


def date_prefix() -> str:
    """The current year-month, as used to filter a monthly report."""
    from datetime import date

    return date.today().strftime("%Y-%m")


if __name__ == "__main__":
    raise SystemExit(main())
