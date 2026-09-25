"""Persistence backends for recorded expenses."""

from __future__ import annotations

import json
import sqlite3
from datetime import date
from pathlib import Path

from .models import Category, Expense, Money


class Store:
    """Base class for anything that can persist and return expenses."""

    def add(self, expense: Expense) -> None:
        """Persist one expense."""
        raise NotImplementedError

    def all(self) -> list[Expense]:
        """Return every expense ever recorded."""
        raise NotImplementedError


class JsonStore(Store):
    """Keeps every expense in a single JSON file on disk."""

    def __init__(self, path: Path):
        self.path = path

    def add(self, expense: Expense) -> None:
        rows = self._rows()
        rows.append(
            {
                "description": expense.description,
                "cents": expense.amount.cents,
                "currency": expense.amount.currency,
                "category": expense.category.value,
                "spent_on": expense.spent_on.isoformat(),
            }
        )
        self.path.write_text(json.dumps(rows, indent=2))

    def all(self) -> list[Expense]:
        expenses = []
        for row in self._rows():
            amount = Money(row["cents"], row["currency"])
            expenses.append(
                Expense(
                    description=row["description"],
                    amount=amount,
                    category=Category(row["category"]),
                    spent_on=date.fromisoformat(row["spent_on"]),
                )
            )
        return expenses

    def _rows(self) -> list[dict]:
        if not self.path.exists():
            return []
        return json.loads(self.path.read_text() or "[]")


class SqliteStore(Store):
    """Keeps expenses in a local SQLite database."""

    def __init__(self, path: Path):
        self.path = path
        self.connection = sqlite3.connect(path)
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS expenses "
            "(description TEXT, cents INTEGER, currency TEXT, category TEXT, spent_on TEXT)"
        )

    def add(self, expense: Expense) -> None:
        self.connection.execute(
            "INSERT INTO expenses VALUES (?, ?, ?, ?, ?)",
            (
                expense.description,
                expense.amount.cents,
                expense.amount.currency,
                expense.category.value,
                expense.spent_on.isoformat(),
            ),
        )
        self.connection.commit()

    def all(self) -> list[Expense]:
        cursor = self.connection.execute("SELECT * FROM expenses")
        return [
            Expense(
                description=row[0],
                amount=Money(row[1], row[2]),
                category=Category(row[3]),
                spent_on=date.fromisoformat(row[4]),
            )
            for row in cursor.fetchall()
        ]
