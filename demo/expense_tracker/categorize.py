"""Guessing a category from free-text descriptions."""

from __future__ import annotations

from .models import Category

DEFAULT_RULES: dict[str, Category] = {
    "supermarket": Category.GROCERIES,
    "market": Category.GROCERIES,
    "bakery": Category.GROCERIES,
    "taxi": Category.TRANSPORT,
    "metro": Category.TRANSPORT,
    "fuel": Category.TRANSPORT,
    "landlord": Category.RENT,
    "cinema": Category.ENTERTAINMENT,
    "concert": Category.ENTERTAINMENT,
}


class Categorizer:
    """Maps a description onto a Category using keyword rules."""

    def __init__(self, rules: dict[str, Category] | None = None):
        self.rules = dict(rules or DEFAULT_RULES)

    def guess(self, description: str) -> Category:
        """Return the first category whose keyword appears in `description`."""
        haystack = description.lower()
        for keyword, category in self.rules.items():
            if keyword in haystack:
                return category
        return Category.OTHER

    def teach(self, keyword: str, category: Category) -> None:
        """Add a rule so future descriptions match `category`."""
        self.rules[keyword.lower()] = category
