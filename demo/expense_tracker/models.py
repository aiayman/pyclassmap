"""Core value objects: money, categories, expenses, and budgets."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum


class Category(Enum):
    """Spending categories an expense can be filed under."""

    GROCERIES = "groceries"
    TRANSPORT = "transport"
    RENT = "rent"
    ENTERTAINMENT = "entertainment"
    OTHER = "other"


@dataclass(frozen=True)
class Money:
    """An amount in minor units (cents), tagged with an ISO currency code."""

    cents: int
    currency: str = "EUR"

    def __add__(self, other: Money) -> Money:
        if self.currency != other.currency:
            raise ValueError(f"cannot add {other.currency} to {self.currency}")
        return Money(self.cents + other.cents, self.currency)

    def __str__(self) -> str:
        return f"{self.cents / 100:.2f} {self.currency}"

    @classmethod
    def parse(cls, text: str, currency: str = "EUR") -> Money:
        """Parse a human amount like '12.34' into Money(1234)."""
        whole, _, frac = text.strip().partition(".")
        return cls(int(whole) * 100 + int((frac + "00")[:2]), currency)


@dataclass
class Expense:
    """A single recorded spend."""

    description: str
    amount: Money
    category: Category
    spent_on: date
    tags: list[str] = field(default_factory=list)


@dataclass
class Budget:
    """A monthly ceiling for one category."""

    category: Category
    limit: Money

    def remaining(self, spent: Money) -> Money:
        """How much of this budget is left after `spent`."""
        return Money(self.limit.cents - spent.cents, self.limit.currency)
