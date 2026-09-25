"""Turning a pile of expenses into readable summaries."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from .models import Budget, Category, Expense, Money


@dataclass
class ReportLine:
    """One category's spend, and the budget it was measured against."""

    category: Category
    spent: Money
    budget: Budget | None = None

    def over_budget(self) -> bool:
        return self.budget is not None and self.spent.cents > self.budget.limit.cents


class Report:
    """Base class for rendered summaries."""

    def render(self) -> str:
        """Return the report as printable text."""
        raise NotImplementedError


@dataclass
class MonthlyReport(Report):
    """Totals for one month, with budget status per category."""

    month: str
    total: Money
    lines: list[ReportLine]

    def render(self) -> str:
        out = [f"Spending for {self.month}: {self.total}"]
        for line in self.lines:
            flag = "  OVER" if line.over_budget() else ""
            out.append(f"  {line.category.value:<14} {line.spent}{flag}")
        return "\n".join(out)


@dataclass
class CategoryBreakdown(Report):
    """Each category's share of total spend, as a percentage."""

    shares: dict[Category, float]

    def render(self) -> str:
        ordered = sorted(self.shares.items(), key=lambda kv: -kv[1])
        return "\n".join(f"  {cat.value:<14} {pct:5.1f}%" for cat, pct in ordered)


def build_monthly_report(
    expenses: list[Expense], budgets: list[Budget], month: str
) -> MonthlyReport:
    """Aggregate `expenses` for `month` into a MonthlyReport."""
    by_category: dict[Category, int] = defaultdict(int)
    currency = "EUR"
    for expense in expenses:
        if expense.spent_on.isoformat().startswith(month):
            by_category[expense.category] += expense.amount.cents
            currency = expense.amount.currency

    limits = {budget.category: budget for budget in budgets}
    lines = []
    for category, cents in sorted(by_category.items(), key=lambda kv: kv[0].value):
        lines.append(ReportLine(category, Money(cents, currency), limits.get(category)))

    total = Money(sum(by_category.values()), currency)
    return MonthlyReport(month=month, total=total, lines=lines)


def build_breakdown(expenses: list[Expense]) -> CategoryBreakdown:
    """Compute each category's percentage share of all spending."""
    totals: dict[Category, int] = defaultdict(int)
    for expense in expenses:
        totals[expense.category] += expense.amount.cents
    grand = sum(totals.values()) or 1
    return CategoryBreakdown({cat: 100 * cents / grand for cat, cents in totals.items()})
