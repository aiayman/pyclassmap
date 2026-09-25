"""The application object that ties storage, categorizing and reporting together."""

from __future__ import annotations

from datetime import date

from .categorize import Categorizer
from .importers import BankStatementImporter, CsvImporter, ImportResult
from .models import Budget, Category, Expense, Money
from .reports import CategoryBreakdown, MonthlyReport, build_breakdown, build_monthly_report
from .storage import Store


class ExpenseTracker:
    """Records spending, keeps budgets, and produces reports.

    The store is injected so the same tracker works against JSON files,
    SQLite, or a test double.
    """

    def __init__(self, store: Store, currency: str = "EUR"):
        self.store = store
        self.currency = currency
        self.categorizer = Categorizer()
        self.budgets: list[Budget] = []

    def record(self, description: str, amount: str, when: date | None = None) -> Expense:
        """Categorize and persist one expense, then return it."""
        expense = Expense(
            description=description,
            amount=Money.parse(amount, self.currency),
            category=self.categorizer.guess(description),
            spent_on=when or date.today(),
        )
        self.store.add(expense)
        return expense

    def set_budget(self, category: Category, limit: str) -> Budget:
        """Set (or replace) the monthly ceiling for one category."""
        budget = Budget(category, Money.parse(limit, self.currency))
        self.budgets = [b for b in self.budgets if b.category is not category]
        self.budgets.append(budget)
        return budget

    def import_csv(self, raw: str) -> ImportResult:
        """Import `date,description,amount,category` rows into the store."""
        importer = CsvImporter()
        result = importer.load(raw)
        for expense in result.imported:
            self.store.add(expense)
        return result

    def import_bank_statement(self, raw: str) -> ImportResult:
        """Import a bank JSON export, guessing categories from memos."""
        importer = BankStatementImporter(self.categorizer)
        result = importer.load(raw)
        for expense in result.imported:
            self.store.add(expense)
        return result

    def monthly_report(self, month: str) -> MonthlyReport:
        """Summarize one month, measured against the current budgets."""
        return build_monthly_report(self.store.all(), self.budgets, month)

    def breakdown(self) -> CategoryBreakdown:
        """Share of spend per category across the whole history."""
        return build_breakdown(self.store.all())

    def overspent(self, month: str) -> list[Category]:
        """Categories that went over budget in `month`."""
        report = self.monthly_report(month)
        return [line.category for line in report.lines if line.over_budget()]
