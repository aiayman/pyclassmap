"""Bringing expenses in from CSV exports and bank statements."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date

from .categorize import Categorizer
from .models import Category, Expense, Money


@dataclass
class ImportResult:
    """What a single import run produced."""

    imported: list[Expense] = field(default_factory=list)
    skipped: int = 0

    def __len__(self) -> int:
        return len(self.imported)


class Importer:
    """Base class for anything that turns raw text into expenses."""

    def load(self, raw: str) -> ImportResult:
        """Parse `raw` into an ImportResult."""
        raise NotImplementedError


class CsvImporter(Importer):
    """Reads `date,description,amount,category` rows."""

    def load(self, raw: str) -> ImportResult:
        result = ImportResult()
        for line in raw.splitlines():
            fields = [cell.strip() for cell in line.split(",")]
            if len(fields) != 4:
                result.skipped += 1
                continue
            when, description, amount, category = fields
            expense = Expense(
                description=description,
                amount=Money.parse(amount),
                category=Category(category),
                spent_on=date.fromisoformat(when),
            )
            result.imported.append(expense)
        return result


class BankStatementImporter(Importer):
    """Reads a bank's JSON export, guessing categories as it goes."""

    def __init__(self, categorizer: Categorizer):
        self.categorizer = categorizer

    def load(self, raw: str) -> ImportResult:
        result = ImportResult()
        for row in json.loads(raw):
            if row.get("type") != "debit":
                result.skipped += 1
                continue
            amount = Money(abs(int(row["amount_cents"])), row.get("currency", "EUR"))
            expense = Expense(
                description=row["memo"],
                amount=amount,
                category=self.categorizer.guess(row["memo"]),
                spent_on=date.fromisoformat(row["booked_on"]),
            )
            result.imported.append(expense)
        return result
